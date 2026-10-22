// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  requireValue,
  uuid,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  getActorFor: "moz-src:///toolkit/actors/PictureInPictureChild.sys.mjs",
});
const EFFECT_TTL = 2 * 60 * 60 * 1000;
const EVENT_FIELDS = {
  play: "playback",
  pause: "playback",
  ended: "playback",
  volumechange: "volume",
  ratechange: "rate",
  seeking: "seek",
  emptied: "source",
  error: "source",
};

function documentId(win) {
  return String(
    win.windowGlobalChild?.innerWindowId ?? win.windowUtils.currentInnerWindowID
  );
}

// Scan light DOM and open shadow roots, without entering another document.
export function scanMediaElements(doc, maxNodes = 50000, maxItems = 512) {
  const roots = [doc];
  const elements = [];
  let scanned = 0;
  for (const root of roots) {
    const walker = doc.createTreeWalker(root, 1);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++scanned > maxNodes) {
        return { elements, truncated: true };
      }
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
      }
      if (
        node.namespaceURI === "http://www.w3.org/1999/xhtml" &&
        ["audio", "video"].includes(node.localName)
      ) {
        if (elements.length === maxItems) {
          return { elements, truncated: true };
        }
        elements.push(node);
      }
    }
  }
  return { elements, truncated: false };
}

export function mediaElementState(media) {
  const ranges = [];
  for (let index = 0; index < Math.min(media.seekable.length, 32); index++) {
    ranges.push({
      start: media.seekable.start(index),
      end: media.seekable.end(index),
    });
  }
  return {
    kind: media.localName,
    label: String(media.getAttribute("aria-label") || media.title || "").slice(
      0,
      200
    ),
    currentSrc: String(media.currentSrc || "").slice(0, 4096),
    paused: media.paused,
    playing: !media.paused && !media.ended,
    ended: media.ended,
    muted: media.muted,
    volume: media.volume,
    playbackRate: media.playbackRate,
    currentTime: Number.isFinite(media.currentTime) ? media.currentTime : null,
    duration: Number.isFinite(media.duration) ? media.duration : null,
    live: media.duration === Infinity,
    readyState: media.readyState,
    seekable: ranges,
    videoWidth: media.videoWidth || 0,
    videoHeight: media.videoHeight || 0,
    pip: !!media.isCloningElementVisually,
    pipFrameId: media.isCloningElementVisually
      ? String(lazy.getActorFor(media)?.browsingContext.id ?? "") || null
      : null,
  };
}

export function validateMediaAction(args) {
  requireValue(
    [
      "play",
      "pause",
      "stop",
      "mute",
      "unmute",
      "volume",
      "rate",
      "seek",
      "pauseForFocus",
      "duckForFocus",
      "restore",
      "pipOpen",
      "pipClose",
    ].includes(args.action),
    "invalid_action",
    "Unknown media action"
  );
  if (["volume", "duckForFocus"].includes(args.action)) {
    requireValue(
      Number.isFinite(args.volume) && args.volume >= 0 && args.volume <= 1,
      "invalid_volume",
      "volume must be a finite number from 0 to 1"
    );
  }
  if (args.action === "rate") {
    requireValue(
      Number.isFinite(args.playbackRate) &&
        args.playbackRate >= 0.0625 &&
        args.playbackRate <= 16,
      "invalid_rate",
      "playbackRate must be from 0.0625 to 16"
    );
  }
  if (args.action === "seek") {
    requireValue(
      (args.positionSeconds !== undefined) !==
        (args.offsetSeconds !== undefined),
      "invalid_seek",
      "Specify exactly one of positionSeconds or offsetSeconds"
    );
    requireValue(
      Number.isFinite(args.positionSeconds ?? args.offsetSeconds),
      "invalid_seek",
      "Seek time must be finite"
    );
  }
}

// Choose a valid point even for live streams or disconnected seekable ranges.
export function seekDestination(media, args) {
  let target = args.positionSeconds ?? media.currentTime + args.offsetSeconds;
  requireValue(
    Number.isFinite(target) && media.readyState >= 1,
    "media_not_ready",
    "Media metadata is not available"
  );
  if (media.seekable.length) {
    let nearest = null;
    for (let index = 0; index < media.seekable.length; index++) {
      const start = media.seekable.start(index);
      const end = media.seekable.end(index);
      if (target >= start && target <= end) {
        return target;
      }
      const candidate = target < start ? start : end;
      if (
        nearest === null ||
        Math.abs(candidate - target) < Math.abs(nearest - target)
      ) {
        nearest = candidate;
      }
    }
    return nearest;
  }
  requireValue(
    Number.isFinite(media.duration) && media.duration > 0,
    "not_seekable",
    "No seekable time range is available"
  );
  return Math.max(0, Math.min(media.duration, target));
}

function bounded(promise, signal, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () =>
      finish(
        reject,
        new McpToolError(
          "cancelled",
          "Media request cancelled; read the current state"
        )
      );
    timer = setTimeout(
      () =>
        finish(
          reject,
          new McpToolError(
            "media_timeout",
            "Media did not finish before the deadline; read its current state"
          )
        ),
      timeoutMs
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    // Drain even a promise supplied immediately after cancellation (notably a
    // native play() promise, which may reject after pause() interrupts it).
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

/** A document-bound endpoint: it cannot ask the parent to choose another tab. */
export class ZenMcpMediaChild extends JSWindowActorChild {
  records = new Map();
  elementIds = new WeakMap();
  effects = new Map();
  requests = new Map();
  busy = new Set();

  didDestroy() {
    for (const controller of this.requests.values()) {
      controller.abort();
    }
    for (const record of this.records.values()) {
      this.removeRecord(record);
    }
    this.records.clear();
    this.effects.clear();
    this.requests.clear();
  }

  removeRecord(record) {
    const media = record.element.deref();
    for (const name of Object.keys(EVENT_FIELDS)) {
      media?.removeEventListener(name, record.listener, {
        mozSystemGroup: true,
      });
    }
  }

  record(media, clientId) {
    let id = this.elementIds.get(media);
    let record = this.records.get(id);
    if (!record) {
      if (this.records.size >= 512) {
        const [oldId, old] = this.records.entries().next().value;
        this.removeRecord(old);
        this.records.delete(oldId);
      }
      id = `media-${uuid()}`;
      record = {
        id,
        element: new WeakRef(media),
        clients: new Set(),
        versions: { playback: 0, volume: 0, rate: 0, seek: 0, source: 0 },
      };
      record.listener = event => {
        if (event.isTrusted) {
          record.versions[EVENT_FIELDS[event.type]]++;
        }
      };
      for (const name of Object.keys(EVENT_FIELDS)) {
        media.addEventListener(name, record.listener, { mozSystemGroup: true });
      }
      this.records.set(id, record);
      this.elementIds.set(media, id);
    }
    record.clients.add(clientId);
    return record;
  }

  take(mediaId, clientId) {
    const record = this.records.get(mediaId);
    const media = record?.element.deref();
    requireValue(
      record?.clients.has(clientId) &&
        media?.isConnected &&
        media.ownerDocument === this.contentWindow.document,
      "stale_media",
      "Media is missing, belongs to another client or changed document; list media again"
    );
    return { record, media };
  }

  async receiveMessage(message) {
    const { clientId, requestId, command, args = {} } = message.data || {};
    if (message.name === "ZenMcpMedia:Cancel") {
      this.requests.get(`${clientId}:${requestId}`)?.abort();
      return undefined;
    }
    if (message.name === "ZenMcpMedia:Cleanup") {
      for (const record of this.records.values()) {
        record.clients.delete(clientId);
      }
      for (const [id, effect] of this.effects) {
        if (effect.clientId === clientId) {
          this.effects.delete(id);
        }
      }
      for (const [key, controller] of this.requests) {
        if (key.startsWith(`${clientId}:`)) {
          controller.abort();
        }
      }
      return undefined;
    }
    if (message.name !== "ZenMcpMedia:Query") {
      throw new Error("Unknown media actor message");
    }
    const key = `${clientId}:${requestId}`;
    const controller = new AbortController();
    let owned = false;
    try {
      requireValue(
        typeof clientId === "string" && typeof requestId === "string",
        "invalid_client",
        "An identified parent request is required"
      );
      requireValue(
        !this.requests.has(key),
        "duplicate_request",
        "Request identifier is already active"
      );
      this.requests.set(key, controller);
      owned = true;
      requireValue(
        this.manager.isCurrentGlobal &&
          !this.manager.isClosed &&
          args.documentId === documentId(this.contentWindow),
        "stale_document",
        "The document changed; list media again"
      );
      let value;
      if (command === "list") {
        const inventory = scanMediaElements(this.contentWindow.document);
        value = {
          items: inventory.elements.map(media => ({
            mediaId: this.record(media, clientId).id,
            ...mediaElementState(media),
          })),
          truncated: inventory.truncated,
        };
      } else {
        requireValue(
          command === "control",
          "invalid_command",
          "Unknown media command"
        );
        validateMediaAction(args);
        const { record, media } = this.take(args.mediaId, clientId);
        requireValue(
          !this.busy.has(record.id),
          "media_busy",
          "Another action is changing this media; read its state before retrying"
        );
        this.busy.add(record.id);
        try {
          value = await this.control(
            media,
            record,
            args,
            clientId,
            controller.signal
          );
        } finally {
          this.busy.delete(record.id);
        }
      }
      return {
        ok: true,
        value: {
          frameId: String(this.browsingContext.id),
          documentId: documentId(this.contentWindow),
          ...value,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof McpToolError
              ? error.code
              : "media_operation_failed",
          message:
            error instanceof McpToolError
              ? error.message
              : "Media action failed; inspect its current state before retrying",
        },
      };
    } finally {
      if (owned) {
        this.requests.delete(key);
      }
    }
  }

  // Listen before mutation; a second native event makes an owned effect stale.
  async changed(media, eventName, mutate, signal) {
    let listener;
    const event = new Promise(resolve => {
      listener = value => {
        if (value.isTrusted) {
          resolve();
        }
      };
      media.addEventListener(eventName, listener, { mozSystemGroup: true });
    });
    try {
      requireValue(!signal.aborted, "cancelled", "The request was cancelled");
      mutate();
      await bounded(event, signal);
    } finally {
      media.removeEventListener(eventName, listener, { mozSystemGroup: true });
    }
  }

  async restoreEffect(media, record, args, clientId, signal) {
    const before = mediaElementState(media);
    const effect = this.effects.get(args.effectId);
    requireValue(
      effect?.clientId === clientId && effect.mediaId === record.id,
      "unknown_effect",
      "This client does not own the effect"
    );
    this.effects.delete(args.effectId);
    if (
      effect.expiresAt < Date.now() ||
      effect.src !== before.currentSrc ||
      Object.entries(effect.versions).some(
        ([key, value]) => record.versions[key] !== value
      ) ||
      Object.entries(effect.expected).some(
        ([key, value]) => before[key] !== value
      )
    ) {
      return {
        mediaId: record.id,
        status: "skipped_changed",
        observed: before,
      };
    }
    if (effect.kind === "pause") {
      await this.play(media, record, signal);
    } else {
      await this.changed(
        media,
        "volumechange",
        () => {
          media.volume = effect.previous;
        },
        signal
      );
    }
    return {
      mediaId: record.id,
      status: "applied",
      observed: mediaElementState(media),
    };
  }

  async control(media, record, args, clientId, signal) {
    requireValue(!signal.aborted, "cancelled", "The request was cancelled");
    if (args.action === "restore") {
      return this.restoreEffect(media, record, args, clientId, signal);
    }
    const before = mediaElementState(media);
    let effectId;
    let status = "applied";
    if (["pauseForFocus", "duckForFocus"].includes(args.action)) {
      const pause = args.action === "pauseForFocus";
      if (
        !before.playing ||
        (!pause && (before.muted || before.volume <= args.volume))
      ) {
        status = "unchanged";
      } else {
        const field = pause ? "playback" : "volume";
        const versions = {
          ...record.versions,
          [field]: record.versions[field] + 1,
        };
        await this.changed(
          media,
          pause ? "pause" : "volumechange",
          () => {
            if (pause) {
              media.pause();
            } else {
              media.volume = args.volume;
            }
          },
          signal
        );
        const observed = mediaElementState(media);
        const expected = pause
          ? { paused: true }
          : { volume: args.volume, muted: before.muted };
        if (
          Object.entries(versions).some(
            ([key, value]) => record.versions[key] !== value
          ) ||
          Object.entries(expected).some(
            ([key, value]) => observed[key] !== value
          ) ||
          before.currentSrc !== observed.currentSrc
        ) {
          status = "changed_during_action";
        } else {
          for (const [id, value] of this.effects) {
            if (value.expiresAt < Date.now()) {
              this.effects.delete(id);
            }
          }
          while (this.effects.size >= 256) {
            this.effects.delete(this.effects.keys().next().value);
          }
          effectId = `media-effect-${uuid()}`;
          this.effects.set(effectId, {
            clientId,
            mediaId: record.id,
            kind: pause ? "pause" : "volume",
            previous: before.volume,
            expected,
            versions,
            src: before.currentSrc,
            expiresAt: Date.now() + EFFECT_TTL,
          });
        }
      }
    } else if (args.action === "pipClose") {
      const player = lazy.getActorFor(media);
      requireValue(
        player && String(player.browsingContext.id) === args.pipFrameId,
        "stale_player",
        "The video's PiP player changed; list players again"
      );
      await bounded(
        player.closePictureInPicture({ reason: "CloseButton" }),
        signal,
        10000
      );
    } else if (args.action === "pipOpen") {
      requireValue(
        media.localName === "video" &&
          media.videoWidth > 0 &&
          media.videoHeight > 0,
        "not_pip_eligible",
        "Select a video with loaded metadata"
      );
      if (before.pip) {
        status = "unchanged";
      } else {
        await bounded(
          this.manager
            .getActor("PictureInPictureLauncher")
            .togglePictureInPicture({ video: media }, args.activate === true),
          signal,
          10000
        );
      }
    } else if (args.action === "play") {
      await this.play(media, record, signal);
    } else if (args.action === "pause") {
      if (!media.paused) {
        await this.changed(media, "pause", () => media.pause(), signal);
      } else {
        status = "unchanged";
      }
    } else if (args.action === "stop") {
      const target = seekDestination(media, { positionSeconds: 0 });
      if (!media.paused) {
        await this.changed(media, "pause", () => media.pause(), signal);
      }
      if (media.currentTime !== target) {
        await this.changed(
          media,
          "seeked",
          () => {
            media.currentTime = target;
          },
          signal
        );
      }
    } else if (args.action === "seek") {
      const target = seekDestination(media, args);
      if (media.currentTime !== target) {
        await this.changed(
          media,
          "seeked",
          () => {
            media.currentTime = target;
          },
          signal
        );
      } else {
        status = "unchanged";
      }
    } else {
      const property = {
        volume: "volume",
        rate: "playbackRate",
        mute: "muted",
        unmute: "muted",
      }[args.action];
      const value = {
        volume: args.volume,
        rate: args.playbackRate,
        mute: true,
        unmute: false,
      }[args.action];
      if (media[property] !== value) {
        await this.changed(
          media,
          property === "playbackRate" ? "ratechange" : "volumechange",
          () => {
            media[property] = value;
          },
          signal
        );
      } else {
        status = "unchanged";
      }
    }
    return {
      mediaId: record.id,
      status,
      ...(effectId ? { effectId } : {}),
      observed: mediaElementState(media),
    };
  }

  async play(media, record, signal) {
    const wasPaused = media.paused;
    const versions = {
      ...record.versions,
      playback: record.versions.playback + 1,
    };
    const source = media.currentSrc;
    const input = this.contentWindow.windowUtils.setHandlingUserInput(true);
    let playing;
    try {
      playing = media.play();
    } finally {
      input.destruct();
    }
    try {
      await bounded(playing, signal);
    } catch (error) {
      // A pending play() can start much later when data arrives. Cancel only
      // our still-owned transition; never pause a subsequent user playback.
      if (
        wasPaused &&
        !media.paused &&
        media.currentSrc === source &&
        Object.entries(versions).every(
          ([key, value]) => record.versions[key] === value
        )
      ) {
        media.pause();
      }
      throw error;
    }
  }
}
