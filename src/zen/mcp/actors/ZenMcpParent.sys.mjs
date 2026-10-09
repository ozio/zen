// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * This actor is a query endpoint, never an authority for child-originated work.
 * A compromised page/process cannot select a parent target or ask the service
 * to evaluate JavaScript, operate chrome, or perform a profile mutation.
 */
export class ZenMcpParent extends JSWindowActorParent {
  receiveMessage() {
    throw new Error("ZenMcp does not accept child-initiated parent commands");
  }
}
