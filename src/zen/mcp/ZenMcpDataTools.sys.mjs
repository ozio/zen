// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  makeTool,
  paginate,
  requireValue,
  schema,
  uuid,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
});

const page = {
  cursor: schema.string,
  limit: { type: "integer", minimum: 1, maximum: 500 },
};
const attributesSchema = {
  type: "object",
  properties: {
    userContextId: { type: "integer", minimum: 0 },
    firstPartyDomain: schema.string,
    partitionKey: schema.string,
  },
  additionalProperties: false,
};
const cookieFields = {
  host: schema.string,
  path: schema.string,
  name: schema.string,
  originAttributes: attributesSchema,
};
const nullableString = { type: ["string", "null"] };
const bookmarkSchema = {
  type: ["object", "null"],
  properties: {
    guid: schema.string,
    parentGuid: schema.string,
    index: schema.integer,
    type: schema.integer,
    title: schema.string,
    url: nullableString,
    dateAdded: nullableString,
    lastModified: nullableString,
    childCount: schema.integer,
  },
};
const downloadSchema = {
  type: "object",
  properties: {
    downloadId: schema.string,
    url: schema.string,
    targetPath: schema.string,
    targetExists: schema.boolean,
    startTime: nullableString,
    stopped: schema.boolean,
    succeeded: schema.boolean,
    canceled: schema.boolean,
    hasPartialData: schema.boolean,
    progress: schema.number,
    currentBytes: schema.number,
    totalBytes: schema.number,
    error: { type: ["object", "null"] },
  },
};
const cookieSchema = {
  type: ["object", "null"],
  properties: {
    ...cookieFields,
    value: schema.string,
    isSecure: schema.boolean,
    isHttpOnly: schema.boolean,
    isSession: schema.boolean,
    expiry: schema.integer,
    sameSite: schema.integer,
    schemeMap: schema.integer,
    isPartitioned: schema.boolean,
    originAttributes: {
      type: "object",
      description: "Non-private Gecko origin attributes",
    },
  },
};
const addonSchema = {
  type: ["object", "null"],
  properties: {
    id: schema.string,
    name: schema.string,
    type: schema.string,
    version: schema.string,
    active: schema.boolean,
    userDisabled: { type: ["boolean", "string"] },
    appDisabled: schema.boolean,
    permissions: schema.integer,
    isSystem: schema.boolean,
    pendingOperations: schema.integer,
  },
};
const permissionSchema = {
  type: "object",
  properties: {
    origin: schema.string,
    permission: schema.string,
    state: schema.integer,
    expireType: schema.integer,
    expireTime: schema.integer,
    originAttributes: schema.object,
  },
};
const preferenceSchema = {
  type: "object",
  properties: {
    name: schema.string,
    type: nullableString,
    value: { type: ["boolean", "integer", "string", "null"] },
    exists: schema.boolean,
    locked: schema.boolean,
    hasUserValue: schema.boolean,
  },
};

function describeOutput(tool, properties) {
  return {
    ...tool,
    outputSchema: {
      ...tool.outputSchema,
      properties: { ...tool.outputSchema.properties, ...properties },
    },
  };
}

function listOutput(item) {
  return {
    items: { type: "array", items: item },
    total: schema.integer,
    nextCursor: schema.string,
  };
}

function string(value, field, allowEmpty = false) {
  requireValue(
    typeof value === "string" && (allowEmpty || !!value.trim().length),
    "invalid_argument",
    `${field} must be a ${allowEmpty ? "" : "non-empty "}string`
  );
  return value;
}

function originAttributes(value = {}) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_origin_attributes",
    "originAttributes must be an object"
  );
  for (const key of Object.keys(value)) {
    requireValue(
      ["userContextId", "partitionKey", "firstPartyDomain"].includes(key),
      "invalid_origin_attributes",
      "Only public container and partition attributes are supported"
    );
  }
  requireValue(
    value.userContextId === undefined ||
      (Number.isInteger(value.userContextId) && value.userContextId >= 0),
    "invalid_origin_attributes",
    "userContextId must be a non-negative integer"
  );
  for (const key of ["partitionKey", "firstPartyDomain"]) {
    requireValue(
      value[key] === undefined || typeof value[key] === "string",
      "invalid_origin_attributes",
      `${key} must be a string`
    );
  }
  return { ...value, privateBrowsingId: 0 };
}

function bookmark(item) {
  if (!item) {
    return null;
  }
  return {
    guid: item.guid,
    parentGuid: item.parentGuid,
    index: item.index,
    type: item.type,
    title: item.title || "",
    url: item.url?.href || null,
    dateAdded: item.dateAdded?.toISOString() || null,
    lastModified: item.lastModified?.toISOString() || null,
    ...(item.childCount === undefined ? {} : { childCount: item.childCount }),
  };
}

function cookie(value) {
  return {
    host: value.host,
    path: value.path,
    name: value.name,
    value: value.value,
    isSecure: value.isSecure,
    isHttpOnly: value.isHttpOnly,
    isSession: value.isSession,
    expiry: value.expiry,
    sameSite: value.sameSite,
    schemeMap: value.schemeMap,
    isPartitioned: value.isPartitioned,
    originAttributes: { ...value.originAttributes },
  };
}

function addon(value) {
  return value
    ? {
        id: value.id,
        name: value.name,
        type: value.type,
        version: value.version,
        active: value.isActive,
        userDisabled: value.userDisabled,
        appDisabled: value.appDisabled,
        permissions: value.permissions,
        isSystem: value.isSystem,
        pendingOperations: value.pendingOperations,
      }
    : null;
}

/** Public-profile APIs. No password store or private download/cookie enumeration. */
export class ZenMcpDataTools {
  constructor(service) {
    this.service = service;
    this.downloadIds = new WeakMap();
    this.installs = new Map();
  }

  getTools() {
    return (this.tools ??= [
      makeTool(
        "zen_bookmarks_list",
        "List a bookmark folder (root by default), search bookmarks, or fetch an explicit GUID. Paginated; dates are ISO strings.",
        {
          ...page,
          parentGuid: schema.string,
          guid: schema.string,
          query: schema.string,
        },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_bookmark",
        "Create, update, move, remove or reorder bookmarks/folders. create requires parentGuid; update/remove require guid. reorder requires parentGuid and orderedGuids.",
        {
          action: schema.enum("create", "update", "remove", "reorder"),
          guid: schema.string,
          parentGuid: schema.string,
          title: schema.string,
          url: schema.string,
          type: schema.enum("bookmark", "folder", "separator"),
          index: { type: "integer", minimum: -1 },
          orderedGuids: schema.strings,
        },
        ["action"]
      ),
      makeTool(
        "zen_history_list",
        "Read public browsing history, newest visit first, or fetch a URL/GUID with paginated visits (total/nextCursor then describe visits). since/until are Unix milliseconds.",
        {
          ...page,
          query: schema.string,
          url: schema.string,
          guid: schema.string,
          since: schema.integer,
          until: schema.integer,
        },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_history",
        "Add a public history visit or remove a specific URL/GUID. add requires url; remove requires url or guid. visitTime uses Unix milliseconds.",
        {
          action: schema.enum("add", "remove"),
          url: schema.string,
          guid: schema.string,
          title: schema.string,
          visitTime: schema.integer,
        },
        ["action"]
      ),
      makeTool(
        "zen_downloads_list",
        "List public downloads; opaque downloadIds remain valid for this browser instance.",
        page,
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_download",
        "Create/start/cancel/remove a public download. create requires url and absolute targetPath. Removing a record does not delete a completed file; removePartialData affects partial data only.",
        {
          action: schema.enum("create", "start", "cancel", "remove"),
          downloadId: schema.string,
          url: schema.string,
          targetPath: schema.string,
          removePartialData: schema.boolean,
        },
        ["action"]
      ),
      makeTool(
        "zen_cookies_list",
        "Read non-private cookies. host is an exact cookie host (including a leading dot for domain cookies); originAttributes optionally filters containers/partitions. expiry is Unix milliseconds.",
        {
          ...page,
          host: schema.string,
          name: schema.string,
          originAttributes: attributesSchema,
        },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_cookie",
        "Set or remove one non-private cookie, addressed by host/path/name/container/partition. Set accepts Unix millisecond expiry (default session), Gecko sameSite 0/1/2/256 and schemeMap 0..3.",
        {
          action: schema.enum("set", "remove"),
          ...cookieFields,
          value: schema.string,
          isSecure: schema.boolean,
          isHttpOnly: schema.boolean,
          isSession: schema.boolean,
          expiry: schema.integer,
          sameSite: { type: "integer", enum: [0, 1, 2, 256] },
          schemeMap: { type: "integer", minimum: 0, maximum: 3 },
          isPartitioned: schema.boolean,
        },
        ["action", "host", "name"]
      ),
      makeTool(
        "zen_storage",
        "Read/change local/session storage or IndexedDB in an explicit tab/frame. Local/session keys and values are strings. IndexedDB list enumerates databases, stores or records; get/set/remove/clear require database and store, using JSON keys/values. list is paginated; returned origin/documentId identify the scope.",
        {
          action: schema.enum("list", "get", "set", "remove", "clear"),
          tabId: schema.string,
          frameId: schema.string,
          area: schema.enum("local", "session", "indexedDB"),
          key: {},
          value: {},
          database: schema.string,
          store: schema.string,
          ...page,
        },
        ["action", "tabId", "area"]
      ),
      makeTool(
        "zen_extensions_list",
        "List installed add-ons, including enable/disable/uninstall capability bits.",
        { ...page, type: schema.string },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_extension",
        "Install a signed extension URL, enable, disable or uninstall an explicit add-on. Gecko signature and policy checks remain enforced. install requires HTTPS URL; other actions require addonId.",
        {
          action: schema.enum("install", "enable", "disable", "uninstall"),
          addonId: schema.string,
          url: schema.string,
        },
        ["action"]
      ),
      makeTool(
        "zen_permissions_list",
        "List saved non-private site permissions (optionally filter exact principal origin and container/partition), or read a specific site's permission state.",
        {
          ...page,
          origin: schema.string,
          permission: schema.string,
          originAttributes: attributesSchema,
        },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_permission",
        "Set/remove a site permission through SitePermissions. origin is an HTTP(S) site; permission must be supported by Gecko. state is a Gecko permission value; scope persistent/session.",
        {
          action: schema.enum("set", "remove"),
          origin: schema.string,
          permission: schema.string,
          state: schema.integer,
          scope: schema.enum("persistent", "session"),
          originAttributes: attributesSchema,
        },
        ["action", "origin", "permission"]
      ),
      makeTool(
        "zen_preferences_list",
        "Read typed preferences, optionally by prefix or exact name. Locked status and presence of a user value are included.",
        { ...page, prefix: schema.string, name: schema.string },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_preference",
        "Set a typed preference or reset its user value. set requires type and matching value; locked preferences cannot be changed. Password databases are not part of this API.",
        {
          action: schema.enum("set", "reset"),
          name: schema.string,
          type: schema.enum("boolean", "integer", "string"),
          value: { type: ["boolean", "integer", "string"] },
        },
        ["action", "name"]
      ),
    ].map(tool => {
      const outputs = {
        zen_bookmarks_list: {
          ...listOutput(bookmarkSchema),
          item: bookmarkSchema,
        },
        zen_bookmark: {
          ...listOutput(bookmarkSchema),
          item: bookmarkSchema,
          guid: schema.string,
          removed: schema.boolean,
        },
        zen_history_list: {
          ...listOutput({
            type: "object",
            properties: {
              guid: schema.string,
              url: schema.string,
              title: schema.string,
              visitCount: schema.integer,
              lastVisitTime: schema.integer,
            },
          }),
          item: {
            type: ["object", "null"],
            properties: {
              guid: schema.string,
              url: schema.string,
              title: schema.string,
              visits: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: schema.string,
                    transition: schema.integer,
                  },
                },
              },
            },
          },
        },
        zen_history: {
          item: { type: ["object", "null"] },
          removed: schema.boolean,
        },
        zen_downloads_list: listOutput(downloadSchema),
        zen_download: {
          downloadId: schema.string,
          item: downloadSchema,
          removed: schema.boolean,
        },
        zen_cookies_list: listOutput(cookieSchema),
        zen_cookie: {
          host: schema.string,
          name: schema.string,
          path: schema.string,
          item: cookieSchema,
          removed: schema.boolean,
        },
        zen_storage: {
          ...listOutput({}),
          origin: schema.string,
          documentId: schema.string,
          area: schema.string,
          key: {},
          value: {},
          database: schema.string,
          store: schema.string,
          removed: schema.boolean,
          cleared: schema.boolean,
        },
        zen_extensions_list: listOutput(addonSchema),
        zen_extension: {
          addonId: schema.string,
          item: addonSchema,
          removed: schema.boolean,
        },
        zen_permissions_list: {
          ...listOutput(permissionSchema),
          ...permissionSchema.properties,
          scope: schema.string,
        },
        zen_permission: {
          origin: schema.string,
          permission: schema.string,
          state: schema.integer,
          scope: schema.string,
        },
        zen_preferences_list: {
          ...listOutput(preferenceSchema),
          item: preferenceSchema,
        },
        zen_preference: { item: preferenceSchema },
      };
      return describeOutput(tool, outputs[tool.name]);
    }));
  }

  owns(name) {
    return this.getTools().some(tool => tool.name === name);
  }

  async execute(name, args, client, signal) {
    this.service.assertInstance(args);
    requireValue(
      !signal?.aborted,
      "cancelled",
      "The request was cancelled before the operation"
    );
    const handlers = {
      zen_bookmarks_list: () => this.bookmarksList(args),
      zen_bookmark: () => this.bookmarkAction(args),
      zen_history_list: () => this.historyList(args),
      zen_history: () => this.historyAction(args),
      zen_downloads_list: () => this.downloadsList(args),
      zen_download: () => this.downloadAction(args),
      zen_cookies_list: () => this.cookiesList(args),
      zen_cookie: () => this.cookieAction(args),
      zen_storage: () => this.storage(args, client, signal),
      zen_extensions_list: () => this.extensionsList(args),
      zen_extension: () => this.extensionAction(args, client, signal),
      zen_permissions_list: () => this.permissionsList(args),
      zen_permission: () => this.permissionAction(args),
      zen_preferences_list: () => this.preferencesList(args),
      zen_preference: () => this.preferenceAction(args),
    };
    requireValue(
      handlers[name],
      "unknown_tool",
      `Unknown profile tool: ${name}`
    );
    return { instanceId: this.service.instanceId, ...(await handlers[name]()) };
  }

  changed(kind) {
    this.service.notify("profile", { kind });
  }

  async bookmarksList(args) {
    const api = lazy.PlacesUtils.bookmarks;
    if (args.guid !== undefined) {
      return { item: bookmark(await api.fetch(string(args.guid, "guid"))) };
    }
    let items;
    if (args.query !== undefined) {
      items = await api.search({ query: string(args.query, "query", true) });
    } else {
      items = [];
      await api.fetch({ parentGuid: args.parentGuid ?? api.rootGuid }, value =>
        items.push(value)
      );
    }
    const slice = paginate(items, args);
    return { ...slice, items: slice.items.map(bookmark) };
  }

  async bookmarkAction(args) {
    const api = lazy.PlacesUtils.bookmarks;
    let item;
    switch (args.action) {
      case "create": {
        const types = {
          bookmark: api.TYPE_BOOKMARK,
          folder: api.TYPE_FOLDER,
          separator: api.TYPE_SEPARATOR,
        };
        const type = args.type ?? "bookmark";
        requireValue(
          type in types,
          "invalid_argument",
          "Unknown bookmark type"
        );
        const info = {
          parentGuid: string(args.parentGuid, "parentGuid"),
          type: types[type],
        };
        if (type === "bookmark") {
          info.url = string(args.url, "url");
        }
        if (args.title !== undefined) {
          info.title = args.title;
        }
        if (args.index !== undefined) {
          info.index = args.index;
        }
        item = await api.insert(info);
        item = await api.fetch(item.guid);
        break;
      }
      case "update": {
        const info = { guid: string(args.guid, "guid") };
        for (const key of ["title", "url", "parentGuid", "index"]) {
          if (args[key] !== undefined) {
            info[key] = args[key];
          }
        }
        requireValue(
          Object.keys(info).length > 1,
          "invalid_argument",
          "Specify at least one field to update"
        );
        await api.update(info);
        item = await api.fetch(info.guid);
        break;
      }
      case "remove": {
        const guid = string(args.guid, "guid");
        await api.remove(guid);
        this.changed("bookmarks");
        return { guid, removed: !(await api.fetch(guid)) };
      }
      case "reorder": {
        const parentGuid = string(args.parentGuid, "parentGuid");
        requireValue(
          Array.isArray(args.orderedGuids) &&
            args.orderedGuids.every(value => typeof value === "string"),
          "invalid_argument",
          "orderedGuids must be an array of GUIDs"
        );
        await api.reorder(parentGuid, args.orderedGuids);
        this.changed("bookmarks");
        return this.bookmarksList({ parentGuid });
      }
      default:
        throw new McpToolError("invalid_action", "Unknown bookmark action");
    }
    this.changed("bookmarks");
    return { item: bookmark(item) };
  }

  async historyList(args) {
    const api = lazy.PlacesUtils.history;
    if (args.url !== undefined || args.guid !== undefined) {
      const value = await api.fetch(args.url ?? args.guid, {
        includeVisits: true,
      });
      const { items: visits, ...paging } = paginate(value?.visits ?? [], args);
      return {
        ...paging,
        item: value
          ? {
              guid: value.guid,
              url: value.url.href,
              title: value.title || "",
              visits: visits.map(visit => ({
                date: visit.date.toISOString(),
                transition: visit.transition,
              })),
            }
          : null,
      };
    }
    const query = api.getNewQuery();
    if (args.query !== undefined) {
      query.searchTerms = args.query;
    }
    for (const [input, output] of [
      ["since", "beginTime"],
      ["until", "endTime"],
    ]) {
      if (args[input] !== undefined) {
        requireValue(
          Number.isSafeInteger(args[input]) && args[input] >= 0,
          "invalid_argument",
          `${input} must be Unix milliseconds`
        );
        query[output] = args[input] * 1000;
      }
    }
    const options = api.getNewQueryOptions();
    options.resultType = Ci.nsINavHistoryQueryOptions.RESULTS_AS_URI;
    options.sortingMode = Ci.nsINavHistoryQueryOptions.SORT_BY_DATE_DESCENDING;
    const result = api.executeQuery(query, options);
    const root = result.root;
    root.containerOpen = true;
    try {
      // Only visit nodes in the requested page, while keeping the native result closed afterwards.
      const slice = paginate(
        {
          length: root.childCount,
          slice(start, end) {
            return Array.from(
              { length: Math.max(0, Math.min(end, this.length) - start) },
              (_, index) => start + index
            );
          },
        },
        args
      );
      slice.items = slice.items.map(index => {
        const node = root.getChild(index);
        return {
          guid: node.pageGuid,
          url: node.uri,
          title: node.title,
          visitCount: node.accessCount,
          lastVisitTime: Math.floor(node.time / 1000),
        };
      });
      return slice;
    } finally {
      root.containerOpen = false;
    }
  }

  async historyAction(args) {
    const api = lazy.PlacesUtils.history;
    if (args.action === "add") {
      const url = string(args.url, "url");
      const visitTime = args.visitTime ?? Date.now();
      requireValue(
        Number.isSafeInteger(visitTime) &&
          visitTime >= 0 &&
          visitTime <= Date.now(),
        "invalid_argument",
        "visitTime must be a past Unix millisecond timestamp"
      );
      await api.insert({
        url,
        title: args.title ?? "",
        visits: [
          { date: new Date(visitTime), transition: api.TRANSITIONS.LINK },
        ],
      });
      this.changed("history");
      return this.historyList({ url });
    }
    requireValue(
      args.action === "remove",
      "invalid_action",
      "Unknown history action"
    );
    const id = string(args.url ?? args.guid, "url or guid");
    await api.remove(id);
    this.changed("history");
    return { removed: !(await api.fetch(id)) };
  }

  download(value) {
    if (!this.downloadIds.has(value)) {
      this.downloadIds.set(value, uuid());
    }
    return {
      downloadId: this.downloadIds.get(value),
      url: value.source.url,
      targetPath: value.target.path,
      targetExists: value.target.exists,
      startTime: value.startTime?.toISOString() || null,
      stopped: value.stopped,
      succeeded: value.succeeded,
      canceled: value.canceled,
      hasPartialData: value.hasPartialData,
      progress: value.progress,
      currentBytes: value.currentBytes,
      totalBytes: value.totalBytes,
      error: value.error
        ? {
            becauseBlocked: value.error.becauseBlocked,
            becauseSourceFailed: value.error.becauseSourceFailed,
            becauseTargetFailed: value.error.becauseTargetFailed,
          }
        : null,
    };
  }

  async publicDownloads() {
    const list = await lazy.Downloads.getList(lazy.Downloads.PUBLIC);
    return {
      list,
      items: (await list.getAll()).filter(value => !value.source.isPrivate),
    };
  }

  async downloadsList(args) {
    const { items } = await this.publicDownloads();
    const slice = paginate(items, args);
    return {
      ...slice,
      items: slice.items.map(value => this.download(value)),
    };
  }

  async downloadAction(args) {
    const { list, items } = await this.publicDownloads();
    if (args.action === "create") {
      const url = string(args.url, "url");
      const uri = Services.io.newURI(url);
      requireValue(
        ["http", "https"].includes(uri.scheme),
        "invalid_argument",
        "Downloads require an HTTP(S) URL"
      );
      const target = string(args.targetPath, "targetPath");
      requireValue(
        PathUtils.isAbsolute(target),
        "invalid_argument",
        "targetPath must be absolute"
      );
      const value = await lazy.Downloads.createDownload({
        source: { url, isPrivate: false },
        target,
      });
      await list.add(value);
      // A download outlives the request; its state is observable through downloads_list.
      this.startDownload(value);
      this.changed("downloads");
      return { item: this.download(value) };
    }
    const id = string(args.downloadId, "downloadId");
    const value = items.find(item => this.download(item).downloadId === id);
    requireValue(
      value,
      "unknown_download",
      "Download no longer exists in this public instance"
    );
    switch (args.action) {
      case "start":
        this.startDownload(value);
        break;
      case "cancel":
        await value.cancel();
        break;
      case "remove":
        await value.cancel();
        await value.finalize(args.removePartialData === true);
        await list.remove(value);
        this.changed("downloads");
        return {
          downloadId: id,
          removed: !(await list.getAll()).includes(value),
        };
      default:
        throw new McpToolError("invalid_action", "Unknown download action");
    }
    this.changed("downloads");
    return { item: this.download(value) };
  }

  startDownload(value) {
    const changed = () => this.changed("downloads");
    value.start().then(changed, changed);
  }

  cookieItems(args) {
    const attrs =
      args.originAttributes === undefined
        ? null
        : originAttributes(args.originAttributes);
    return Array.from(Services.cookies.cookies).filter(
      value =>
        !value.originAttributes.privateBrowsingId &&
        (args.host === undefined || value.host === args.host) &&
        (args.name === undefined || value.name === args.name) &&
        (!attrs ||
          Object.entries(attrs).every(
            ([key, attribute]) =>
              (value.originAttributes[key] ??
                (typeof attribute === "number" ? 0 : "")) === attribute
          ))
    );
  }

  cookiesList(args) {
    const slice = paginate(this.cookieItems(args), args);
    return { ...slice, items: slice.items.map(cookie) };
  }

  cookieAction(args) {
    const host = string(args.host, "host", true);
    const name = string(args.name, "name", true);
    const path = args.path ?? "/";
    requireValue(
      typeof path === "string" && path.startsWith("/"),
      "invalid_argument",
      "path must start with /"
    );
    const attrs = originAttributes(args.originAttributes);
    if (args.action === "set") {
      const value = string(args.value, "value", true);
      const expiry = args.expiry ?? 8640000000000000;
      requireValue(
        Number.isSafeInteger(expiry) && expiry >= 0,
        "invalid_argument",
        "expiry must be Unix milliseconds"
      );
      const sameSite = args.sameSite ?? Ci.nsICookie.SAMESITE_UNSET;
      const schemeMap = args.schemeMap ?? 0;
      requireValue(
        [0, 1, 2, 256].includes(sameSite) &&
          Number.isInteger(schemeMap) &&
          schemeMap >= 0 &&
          schemeMap <= 3,
        "invalid_argument",
        "Invalid sameSite or schemeMap"
      );
      const validation = Services.cookies.add(
        host,
        path,
        name,
        value,
        args.isSecure ?? false,
        args.isHttpOnly ?? false,
        args.isSession ?? args.expiry === undefined,
        expiry,
        attrs,
        sameSite,
        schemeMap,
        args.isPartitioned ?? false
      );
      requireValue(
        !validation || validation.result === Ci.nsICookieValidation.eOK,
        "cookie_rejected",
        validation?.errorString || "Gecko rejected the cookie"
      );
    } else {
      requireValue(
        args.action === "remove",
        "invalid_action",
        "Unknown cookie action"
      );
      Services.cookies.remove(host, name, path, attrs);
    }
    this.changed("cookies");
    const matches = this.cookieItems({
      host,
      name,
      originAttributes: args.originAttributes ?? {},
    }).filter(item => item.path === path);
    return {
      host,
      name,
      path,
      item: matches.length ? cookie(matches[0]) : null,
      removed:
        args.action === "remove" &&
        !Services.cookies.cookieExists(host, path, name, attrs),
    };
  }

  async storage(args, client, signal) {
    requireValue(
      ["list", "get", "set", "remove", "clear"].includes(args.action),
      "invalid_action",
      "Unknown storage action"
    );
    requireValue(
      ["local", "session", "indexedDB"].includes(args.area),
      "invalid_argument",
      "area must be local, session or indexedDB"
    );
    string(args.tabId, "tabId");
    if (args.area === "indexedDB") {
      if (args.action !== "list") {
        string(args.database, "database");
        string(args.store, "store");
      }
      if (args.store !== undefined) {
        string(args.database, "database");
        string(args.store, "store");
      }
      if (["get", "set", "remove"].includes(args.action)) {
        requireValue(
          args.key !== undefined,
          "invalid_argument",
          "key is required"
        );
      }
      if (args.action === "set") {
        requireValue(
          args.value !== undefined,
          "invalid_argument",
          "value is required"
        );
      }
    } else {
      if (["get", "set", "remove"].includes(args.action)) {
        string(args.key, "key", true);
      }
      if (args.action === "set") {
        string(args.value, "value", true);
      }
    }
    const result = await this.service.pageTools.query(
      args.tabId,
      args.frameId,
      "storage",
      {
        action: args.action,
        area: args.area,
        key: args.key,
        value: args.value,
        database: args.database,
        store: args.store,
        cursor: args.cursor,
        limit: args.limit,
      },
      client,
      signal
    );
    if (!["list", "get"].includes(args.action)) {
      this.changed("storage");
    }
    return result;
  }

  async extensionsList(args) {
    const items = (await lazy.AddonManager.getAllAddons()).filter(
      value => args.type === undefined || value.type === args.type
    );
    const slice = paginate(items, args);
    return { ...slice, items: slice.items.map(addon) };
  }

  async extensionAction(args, client, signal) {
    const api = lazy.AddonManager;
    if (args.action === "install") {
      const url = string(args.url, "url");
      requireValue(
        Services.io.newURI(url).scheme === "https",
        "invalid_argument",
        "Extension installation requires an HTTPS URL"
      );
      const install = await api.getInstallForURL(url);
      requireValue(
        install,
        "extension_install_unavailable",
        "Gecko did not provide an installer for this URL"
      );
      requireValue(
        !signal?.aborted,
        "cancelled",
        "Request cancelled before extension installation"
      );
      const key = uuid();
      this.installs.set(key, { clientId: client.id, install });
      const abort = () => {
        try {
          install.cancel();
        } catch {}
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const installed = await install.install();
        this.changed("extensions");
        return { item: addon(await api.getAddonByID(installed.id)) };
      } finally {
        signal?.removeEventListener("abort", abort);
        this.installs.delete(key);
      }
    }
    const id = string(args.addonId, "addonId");
    const value = await api.getAddonByID(id);
    requireValue(value, "unknown_addon", "Add-on does not exist");
    const permission = {
      enable: api.PERM_CAN_ENABLE,
      disable: api.PERM_CAN_DISABLE,
      uninstall: api.PERM_CAN_UNINSTALL,
    }[args.action];
    requireValue(
      permission !== undefined,
      "invalid_action",
      "Unknown extension action"
    );
    requireValue(
      (value.permissions & permission) !== 0,
      "addon_policy",
      "This operation is not allowed for the add-on"
    );
    if (args.action === "enable") {
      await value.enable();
    }
    if (args.action === "disable") {
      await value.disable();
    }
    if (args.action === "uninstall") {
      await value.uninstall();
    }
    this.changed("extensions");
    const updated = await api.getAddonByID(id);
    return {
      addonId: id,
      item: addon(updated),
      removed: args.action === "uninstall" && !updated,
    };
  }

  principal(args) {
    const origin = string(args.origin, "origin");
    const uri = Services.io.newURI(origin);
    requireValue(
      ["http", "https"].includes(uri.scheme) && uri.prePath === origin,
      "invalid_origin",
      "origin must be an HTTP(S) site origin without a path"
    );
    return Services.scriptSecurityManager.createContentPrincipal(
      uri,
      originAttributes(args.originAttributes)
    );
  }

  permissionsList(args) {
    if (args.origin !== undefined && args.permission !== undefined) {
      const principal = this.principal(args);
      requireValue(
        lazy.SitePermissions.listPermissions().includes(args.permission),
        "unknown_permission",
        "Unsupported site permission"
      );
      return {
        origin: principal.origin,
        permission: args.permission,
        ...lazy.SitePermissions.getForPrincipal(principal, args.permission),
      };
    }
    const attrs =
      args.originAttributes === undefined
        ? null
        : originAttributes(args.originAttributes);
    const principal = args.origin === undefined ? null : this.principal(args);
    const items = Array.from(Services.perms.all).filter(
      value =>
        !value.principal.originAttributes.privateBrowsingId &&
        (!principal || value.principal.origin === principal.origin) &&
        (args.permission === undefined || value.type === args.permission) &&
        (!attrs ||
          Object.entries(attrs).every(
            ([key, valueAttr]) =>
              (value.principal.originAttributes[key] ??
                (typeof valueAttr === "number" ? 0 : "")) === valueAttr
          ))
    );
    const slice = paginate(items, args);
    return {
      ...slice,
      items: slice.items.map(value => ({
        origin: value.principal.origin,
        permission: value.type,
        state: value.capability,
        expireType: value.expireType,
        expireTime: value.expireTime,
        originAttributes: { ...value.principal.originAttributes },
      })),
    };
  }

  permissionAction(args) {
    const api = lazy.SitePermissions;
    const principal = this.principal(args);
    const permission = string(args.permission, "permission");
    requireValue(
      api.listPermissions().includes(permission),
      "unknown_permission",
      "Unsupported site permission"
    );
    if (args.action === "set") {
      requireValue(
        api.getAvailableStates(permission).includes(args.state),
        "invalid_permission_state",
        "State is not supported for this permission"
      );
      requireValue(
        args.scope === undefined ||
          ["persistent", "session"].includes(args.scope),
        "invalid_argument",
        "Invalid permission scope"
      );
      api.setForPrincipal(
        principal,
        permission,
        args.state,
        args.scope === "session" ? api.SCOPE_SESSION : api.SCOPE_PERSISTENT
      );
    } else {
      requireValue(
        args.action === "remove",
        "invalid_action",
        "Unknown permission action"
      );
      api.removeFromPrincipal(principal, permission);
    }
    this.changed("permissions");
    return {
      origin: principal.origin,
      permission,
      ...api.getForPrincipal(principal, permission),
    };
  }

  preference(name) {
    const prefs = Services.prefs;
    const native = prefs.getPrefType(name);
    let type = null;
    let value = null;
    if (native === prefs.PREF_BOOL) {
      type = "boolean";
      value = prefs.getBoolPref(name);
    }
    if (native === prefs.PREF_INT) {
      type = "integer";
      value = prefs.getIntPref(name);
    }
    if (native === prefs.PREF_STRING) {
      type = "string";
      value = prefs.getStringPref(name);
    }
    return {
      name,
      type,
      value,
      exists: type !== null,
      locked: prefs.prefIsLocked(name),
      hasUserValue: prefs.prefHasUserValue(name),
    };
  }

  preferencesList(args) {
    if (args.name !== undefined) {
      return { item: this.preference(string(args.name, "name")) };
    }
    const names = Services.prefs.getChildList(args.prefix ?? "").sort();
    const slice = paginate(names, args);
    return {
      ...slice,
      items: slice.items.map(name => this.preference(name)),
    };
  }

  preferenceAction(args) {
    const name = string(args.name, "name");
    const prefs = Services.prefs;
    requireValue(
      !prefs.prefIsLocked(name),
      "locked_preference",
      "This preference is locked"
    );
    if (args.action === "set") {
      const existing = this.preference(name);
      requireValue(
        !existing.exists || existing.type === args.type,
        "preference_type_mismatch",
        "Use the existing preference type"
      );
      switch (args.type) {
        case "boolean":
          requireValue(
            typeof args.value === "boolean",
            "invalid_argument",
            "value must be boolean"
          );
          prefs.setBoolPref(name, args.value);
          break;
        case "string":
          requireValue(
            typeof args.value === "string",
            "invalid_argument",
            "value must be a string"
          );
          prefs.setStringPref(name, args.value);
          break;
        case "integer":
          requireValue(
            Number.isInteger(args.value) &&
              args.value >= -2147483648 &&
              args.value <= 2147483647,
            "invalid_argument",
            "value must be a 32-bit signed integer"
          );
          prefs.setIntPref(name, args.value);
          break;
        default:
          throw new McpToolError(
            "invalid_argument",
            "type must be boolean, integer or string"
          );
      }
    } else {
      requireValue(
        args.action === "reset",
        "invalid_action",
        "Unknown preference action"
      );
      prefs.clearUserPref(name);
    }
    this.changed("preferences");
    return { item: this.preference(name) };
  }

  cleanup(clientId) {
    for (const [key, value] of this.installs) {
      if (value.clientId === clientId) {
        try {
          value.install.cancel();
        } catch {}
        this.installs.delete(key);
      }
    }
  }

  destroy() {
    for (const value of this.installs.values()) {
      try {
        value.install.cancel();
      } catch {}
    }
    this.installs.clear();
    this.downloadIds = new WeakMap();
  }
}
