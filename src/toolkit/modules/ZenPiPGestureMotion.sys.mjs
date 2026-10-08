/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// CSS screen coordinates throughout. Native input and window APIs belong in
// the adapter, so other platforms can reuse the geometry and motion policy.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const VELOCITY_WINDOW_MS = 80;
const FRICTION_PER_MS = 0.01;
const MIN_COAST_SPEED = 0.025;

export function fitPiPRect(rect, bounds, scale = 1) {
  if (
    ![
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      scale,
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    scale <= 0
  ) {
    throw new RangeError("Invalid PiP geometry");
  }
  const maximum = Math.min(
    bounds.width / rect.width,
    bounds.height / rect.height,
  );
  const minimum = Math.min(
    maximum,
    Math.max(160 / rect.width, 90 / rect.height),
  );
  const applied = clamp(scale, minimum, maximum);
  const width = rect.width * applied;
  const height = rect.height * applied;
  return {
    x: clamp(
      rect.x + (rect.width - width) / 2,
      bounds.x,
      bounds.x + bounds.width - width,
    ),
    y: clamp(
      rect.y + (rect.height - height) / 2,
      bounds.y,
      bounds.y + bounds.height - height,
    ),
    width,
    height,
  };
}

export function movePiPRect(rect, bounds, dx, dy) {
  return {
    ...rect,
    x: clamp(rect.x + dx, bounds.x, bounds.x + bounds.width - rect.width),
    y: clamp(rect.y + dy, bounds.y, bounds.y + bounds.height - rect.height),
  };
}

// Large windows keep as much padding as fits without resizing the video.
function motionBounds(rect, bounds, padding) {
  const gap = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  const x = Math.min(gap, Math.max(0, (bounds.width - rect.width) / 2));
  const y = Math.min(gap, Math.max(0, (bounds.height - rect.height) / 2));
  return {
    x: bounds.x + x,
    y: bounds.y + y,
    width: bounds.width - 2 * x,
    height: bounds.height - 2 * y,
  };
}

export function cornerPiPRect(rect, bounds, padding, dx, dy) {
  const area = motionBounds(rect, bounds, padding);
  return {
    ...rect,
    x: dx > 0 ? area.x + area.width - rect.width : area.x,
    y: dy > 0 ? area.y + area.height - rect.height : area.y,
  };
}

export class ZenPiPGestureMotion {
  constructor(
    host,
    {
      flingSpeed = 0.65,
      flingDistance = 12,
      snapDuration = 180,
      edgePadding = 16,
    } = {},
  ) {
    this.host = host;
    this.options = { flingSpeed, flingDistance, snapDuration, edgePadding };
    this.phase = "idle";
    this.frame = null;
    this.generation = 0;
    this.samples = [];
    this.travel = { x: 0, y: 0 };
    this.rect = null;
    this.bounds = null;
  }

  begin(time = this.host.now()) {
    this.stop();
    // Freeze this monitor for the whole gesture and its ensuing animation.
    this.bounds = { ...this.host.readBounds() };
    this.rect = fitPiPRect(this.host.readRect(), this.bounds);
    this.travel = { x: 0, y: 0 };
    this.samples = [{ time, x: 0, y: 0 }];
    this.phase = "pan";
  }

  pan(dx, dy, time = this.host.now()) {
    if (![dx, dy, time].every(Number.isFinite) || (!dx && !dy)) {
      return;
    }
    if (this.phase !== "pan") {
      this.begin(time - 16);
    }
    this.travel.x += dx;
    this.travel.y += dy;
    this.samples.push({ time, ...this.travel });
    while (
      this.samples.length > 2 &&
      this.samples[1].time < time - VELOCITY_WINDOW_MS
    ) {
      this.samples.shift();
    }
    this.write(movePiPRect(this.rect, this.bounds, dx, dy));
  }

  // AppKit owns mouse dragging. Sample its actual window positions without
  // writing them a second time; only release animation moves the window here.
  observePosition(rect, time = this.host.now()) {
    if (
      this.phase !== "pan" ||
      !this.rect ||
      ![rect.x, rect.y, rect.width, rect.height, time].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return;
    }
    const dx = rect.x - this.rect.x;
    const dy = rect.y - this.rect.y;
    this.rect = { ...rect };
    if (!dx && !dy) {
      return; // Rest ages the last movement sample rather than refreshing it.
    }
    this.travel.x += dx;
    this.travel.y += dy;
    this.samples.push({ time, ...this.travel });
    while (
      this.samples.length > 2 &&
      this.samples[1].time < time - VELOCITY_WINDOW_MS
    ) {
      this.samples.shift();
    }
  }

  pinch(scale) {
    if (!Number.isFinite(scale) || scale <= 0) {
      return;
    }
    if (this.phase !== "pinch") {
      this.begin();
      this.phase = "pinch";
    }
    this.write(fitPiPRect(this.rect, this.bounds, scale));
  }

  velocity(time) {
    const latest = this.samples.at(-1);
    if (!latest || latest.time <= time - VELOCITY_WINDOW_MS) {
      return { x: 0, y: 0 };
    }
    let first = this.samples[0];
    const cutoff = time - VELOCITY_WINDOW_MS;
    for (let i = 1; i < this.samples.length; i++) {
      const next = this.samples[i];
      if (next.time >= cutoff) {
        if (first.time < cutoff && next.time > first.time) {
          const fraction = (cutoff - first.time) / (next.time - first.time);
          first = {
            time: cutoff,
            x: first.x + (next.x - first.x) * fraction,
            y: first.y + (next.y - first.y) * fraction,
          };
        }
        break;
      }
      first = next;
    }
    const elapsed = time - first.time;
    if (elapsed <= 0) {
      return { x: 0, y: 0 };
    }
    // Include time spent resting before release: resting fingers must not fling.
    return {
      x: clamp((latest.x - first.x) / elapsed, -4, 4),
      y: clamp((latest.y - first.y) / elapsed, -4, 4),
    };
  }

  end(time = this.host.now()) {
    if (this.phase !== "pan" || this.samples.length < 2) {
      this.stop();
      return;
    }
    const velocity = this.velocity(time);
    const speed = Math.hypot(velocity.x, velocity.y);
    const diagonal =
      Math.min(Math.abs(velocity.x), Math.abs(velocity.y)) >= speed * 0.35;
    if (
      speed >= this.options.flingSpeed &&
      diagonal &&
      Math.hypot(this.travel.x, this.travel.y) >= this.options.flingDistance
    ) {
      this.snap(velocity);
    } else if (speed >= MIN_COAST_SPEED) {
      this.coast(velocity);
    } else {
      this.stop();
    }
  }

  write(rect) {
    this.rect = this.host.writeRect(rect) ?? rect;
  }

  animate(step) {
    const generation = this.generation;
    this.frame = this.host.requestFrame((time) => {
      if (generation !== this.generation) {
        return;
      }
      this.frame = null;
      if (step(time)) {
        this.animate(step);
      } else {
        this.phase = "idle";
      }
    });
  }

  coast(velocity) {
    this.phase = "coast";
    let previous = this.host.now();
    this.animate((time) => {
      const elapsed = Math.max(0, time - previous);
      previous = time;
      const decay = Math.exp(-FRICTION_PER_MS * elapsed);
      const dx = (velocity.x * (1 - decay)) / FRICTION_PER_MS;
      const dy = (velocity.y * (1 - decay)) / FRICTION_PER_MS;
      const next = movePiPRect(
        this.rect,
        motionBounds(this.rect, this.bounds, this.options.edgePadding),
        dx,
        dy,
      );
      if (Math.abs(next.x - (this.rect.x + dx)) > 0.001) {
        velocity.x = 0;
      }
      if (Math.abs(next.y - (this.rect.y + dy)) > 0.001) {
        velocity.y = 0;
      }
      this.write(next);
      velocity.x *= decay;
      velocity.y *= decay;
      return Math.hypot(velocity.x, velocity.y) >= MIN_COAST_SPEED;
    });
  }

  snap(velocity) {
    this.phase = "snap";
    const from = { ...this.rect };
    const to = cornerPiPRect(
      from,
      this.bounds,
      this.options.edgePadding,
      velocity.x,
      velocity.y,
    );
    const duration = clamp(this.options.snapDuration, 0, 1000);
    if (!duration) {
      this.write(to);
      this.phase = "idle";
      return;
    }
    const start = this.host.now();
    this.animate((time) => {
      const progress = clamp((time - start) / duration, 0, 1);
      const eased = 1 - (1 - progress) ** 3;
      this.write({
        ...from,
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      });
      return progress < 1;
    });
  }

  stop() {
    this.generation++;
    if (this.frame !== null) {
      this.host.cancelFrame(this.frame);
      this.frame = null;
    }
    this.phase = "idle";
    this.samples = [];
  }
}
