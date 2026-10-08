/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TranslationsParent: "resource://gre/actors/TranslationsParent.sys.mjs",
  TranslationsUtils:
    "chrome://global/content/translations/TranslationsUtils.mjs",
});

const TARGET_LANGUAGE = "ru";
// Native startup awaits a port before setting requestedLanguagePair. Keep a
// per-actor lock across menu reopenings during that interval.
const pendingActors = new WeakSet();
const restoringActors = new WeakSet();

/**
 * One page-menu instance, bound to the document that received the right-click.
 * Firefox owns language detection, local model downloads, translation and reload
 * of the original document. UI/preferred languages do not choose this target.
 */
export class ZenPageTranslations {
  #browser;
  #windowGlobal;
  #item;
  #onUpdate;
  #actor = null;
  #languagePairs = null;
  #initializing = true;
  #destroyed = false;

  constructor(browser, windowGlobal, item, onUpdate) {
    this.#browser = browser;
    this.#windowGlobal = windowGlobal;
    this.#item = item;
    this.#onUpdate = onUpdate;
    item.hidden = true;
    item.disabled = true;
  }

  /** Prepare the item without blocking the rest of the context menu. */
  async init() {
    if (!this.#isAvailable()) {
      return;
    }

    try {
      this.#actor = lazy.TranslationsParent.getTranslationsActor(this.#browser);
      if (!this.#actor.isTopLevelActor() || !this.#actor.languageState) {
        this.#actor = null;
        return;
      }
      this.#browser.addEventListener("TranslationsParent:LanguageState", this);
      this.#render();

      // Restoring an active (or partially failed) translation needs no catalog or
      // language lookup. It must also work while models are still downloading.
      if (this.#hasTranslation()) {
        return;
      }

      const [, languagePairs] = await Promise.all([
        this.#actor.getLangTags(),
        lazy.TranslationsParent.getNonPivotLanguagePairs(),
      ]);
      if (!this.#isCurrentDocument()) {
        return;
      }
      this.#languagePairs = languagePairs;
    } finally {
      this.#initializing = false;
      this.#render();
    }
  }

  handleEvent(event) {
    if (event.detail?.actor === this.#actor) {
      this.#render();
      if (
        !this.#initializing &&
        !this.#languagePairs &&
        this.#actor.languageState.error &&
        !this.#hasTranslation()
      ) {
        // A menu opened during native model loading did not need a catalog.
        // If loading fails without changing content, prepare its retry action.
        this.#initializing = true;
        this.init().catch(console.error);
      }
    }
  }

  /** Stop a late language lookup from changing a later menu's shared element. */
  destroy() {
    this.#destroyed = true;
    this.#browser.removeEventListener("TranslationsParent:LanguageState", this);
  }

  #isCurrentDocument() {
    return (
      !this.#destroyed &&
      this.#browser.isConnected &&
      this.#windowGlobal &&
      this.#browser.browsingContext?.currentWindowGlobal === this.#windowGlobal
    );
  }

  #isAvailable() {
    return (
      this.#isCurrentDocument() &&
      lazy.TranslationsParent.AIFeature.isEnabled &&
      lazy.TranslationsParent.getIsTranslationsEngineSupported() &&
      !lazy.TranslationsParent.isFullPageTranslationsRestrictedForPage({
        selectedBrowser: this.#browser,
        currentURI: this.#browser.currentURI,
      })
    );
  }

  #hasTranslation() {
    const state = this.#actor?.languageState;
    return !!(
      state?.requestedLanguagePair ||
      state?.hasVisibleChange ||
      (this.#actor && restoringActors.has(this.#actor))
    );
  }

  #getLanguagePair() {
    if (!this.#languagePairs) {
      return null;
    }
    const docLangTag = this.#actor.languageState.detectedLanguages?.docLangTag;
    if (lazy.TranslationsUtils.langTagsMatch(docLangTag, TARGET_LANGUAGE)) {
      return null;
    }
    const sourceLanguage =
      lazy.TranslationsParent.findCompatibleSourceLangTagSync(
        docLangTag,
        this.#languagePairs,
      );
    const targetSupported =
      lazy.TranslationsParent.findCompatibleTargetLangTagSync(
        TARGET_LANGUAGE,
        this.#languagePairs,
      );
    // The native catalog guarantees pivot coverage for its supported languages.
    return sourceLanguage && targetSupported
      ? { sourceLanguage, targetLanguage: TARGET_LANGUAGE }
      : null;
  }

  #render() {
    if (this.#destroyed) {
      return;
    }
    const restore = this.#hasTranslation();
    const languagePair = this.#actor ? this.#getLanguagePair() : null;
    this.#item.label = restore ? "Показать оригинал" : "Перевести на русский";
    this.#item.hidden =
      !this.#isAvailable() ||
      !this.#actor ||
      (!restore && !languagePair && !this.#initializing);
    this.#item.disabled =
      !this.#actor ||
      restoringActors.has(this.#actor) ||
      (pendingActors.has(this.#actor) && !restore) ||
      (!restore && !languagePair);
    this.#onUpdate();
  }

  /**
   * Act on the captured top-level actor, never a newly selected tab/document.
   * Returns false when unavailable, still initializing or already starting.
   */
  async toggle() {
    const restore = this.#hasTranslation();
    if (
      !this.#isAvailable() ||
      !this.#actor ||
      restoringActors.has(this.#actor) ||
      (pendingActors.has(this.#actor) && !restore) ||
      lazy.TranslationsParent.getTranslationsActor(this.#browser) !==
        this.#actor
    ) {
      return false;
    }

    const languagePair = restore ? null : this.#getLanguagePair();
    if (!restore && !languagePair) {
      return false;
    }

    pendingActors.add(this.#actor);
    if (restore) {
      restoringActors.add(this.#actor);
      this.#render();
      try {
        this.#actor.restorePage();
      } catch (error) {
        restoringActors.delete(this.#actor);
        pendingActors.delete(this.#actor);
        this.#render();
        throw error;
      }
      // Keep the old actor locked until native reload replaces its WindowGlobal.
      return true;
    }

    this.#render();
    try {
      await this.#actor.translate(languagePair, false);
      return true;
    } finally {
      pendingActors.delete(this.#actor);
      this.#render();
    }
  }
}
