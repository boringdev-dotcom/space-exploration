import * as THREE from "three";

import type { ShipState } from "./FlightDynamics";

/**
 * Mission phase state machine. Owns transition logic between
 * `liftoff -> cruise -> approach -> touchdown` based on ship state. The
 * scene polls `update()` each frame; transitions emit one-shot callbacks
 * the host can hook for audio cues, post-fx biases, throttle clamps, etc.
 */

export type MissionPhase =
  | "liftoff"
  | "cruise"
  | "approach"
  | "touchdown"
  | "landed";

export interface PhaseFeel {
  /** Throttle ceiling applied by the host (0..2). Default 2 (uncapped). */
  throttleCeiling: number;
  /** Whether boost is allowed in this phase. */
  boostAllowed: boolean;
  /** Bloom multiplier bias added on top of the input-driven bloom. */
  bloomBias: number;
  /** Camera shake amplitude scalar. */
  shakeScale: number;
}

const FEEL_BY_PHASE: Record<MissionPhase, PhaseFeel> = {
  liftoff: { throttleCeiling: 2, boostAllowed: false, bloomBias: 0.10, shakeScale: 1.0 },
  cruise: { throttleCeiling: 2, boostAllowed: true, bloomBias: 0, shakeScale: 1.0 },
  approach: { throttleCeiling: 1.0, boostAllowed: false, bloomBias: 0.08, shakeScale: 0.55 },
  touchdown: { throttleCeiling: 0.4, boostAllowed: false, bloomBias: 0.06, shakeScale: 0.18 },
  landed: { throttleCeiling: 0, boostAllowed: false, bloomBias: 0, shakeScale: 0 },
};

export interface PhaseControllerOpts {
  /** World origin of Earth (always (0,0,0) in MissionScene, but configurable). */
  earthCenter: THREE.Vector3;
  /** Earth radius in world units. */
  earthRadius: number;
  /** World position of the destination planet's centre. */
  destinationCenter: THREE.Vector3;
  /** Destination planet's radius in world units. */
  destinationRadius: number;
  /** Distance above Earth (units) at which liftoff hands control over. */
  liftoffHandoffAltitude?: number;
  /** Distance to destination centre (units) at which approach starts. */
  approachDistance?: number;
  /** Distance above destination surface (units) at which touchdown starts. */
  touchdownAltitude?: number;
  /** Touchdown handoff: speed (units/sec) below which we hand off to walking. */
  touchdownSpeed?: number;
  /** Touchdown handoff: altitude (units) below which we hand off. */
  touchdownAgl?: number;
}

export interface PhaseEvents {
  onPhaseChange?: (next: MissionPhase, prev: MissionPhase) => void;
}

export class PhaseController {
  private _phase: MissionPhase = "liftoff";
  private opts: Required<PhaseControllerOpts>;
  private events: PhaseEvents;

  /** True after the player has fired the engines in liftoff. */
  ignited = false;

  /**
   * When true, {@link update} is a no-op — the phase machine freezes at
   * its current value and ignores ship state. Used by the free-flight
   * mode so the player can fly past the destination without phase
   * progression triggering "approach" / "touchdown" feel changes.
   */
  paused = false;

  constructor(opts: PhaseControllerOpts, events: PhaseEvents = {}) {
    this.opts = {
      liftoffHandoffAltitude: 8,
      approachDistance: 200,
      touchdownAltitude: 8,
      touchdownSpeed: 0.05,
      touchdownAgl: 0.5,
      ...opts,
    };
    this.events = events;
  }

  get phase(): MissionPhase {
    return this._phase;
  }

  /** World position of the destination planet's centre. */
  get destinationCenter(): THREE.Vector3 {
    return this.opts.destinationCenter;
  }

  /** Destination planet's radius (world units). */
  get destinationRadius(): number {
    return this.opts.destinationRadius;
  }

  /** Earth radius (world units). */
  get earthRadius(): number {
    return this.opts.earthRadius;
  }

  /** Earth centre (world units). */
  get earthCenter(): THREE.Vector3 {
    return this.opts.earthCenter;
  }

  feel(): PhaseFeel {
    return FEEL_BY_PHASE[this._phase];
  }

  /** Distance above the Earth's surface (units). Negative inside Earth. */
  altitudeAboveEarth(ship: ShipState): number {
    return ship.position.distanceTo(this.opts.earthCenter) - this.opts.earthRadius;
  }

  /** Distance above the destination surface (units). */
  altitudeAboveDestination(ship: ShipState): number {
    return (
      ship.position.distanceTo(this.opts.destinationCenter) -
      this.opts.destinationRadius
    );
  }

  /** Straight-line distance to destination centre (units). */
  rangeToDestination(ship: ShipState): number {
    return ship.position.distanceTo(this.opts.destinationCenter);
  }

  /**
   * Check phase transitions against the ship state. Call once per frame.
   * Returns the (possibly updated) current phase.
   */
  update(ship: ShipState): MissionPhase {
    if (this.paused) return this._phase;
    switch (this._phase) {
      case "liftoff": {
        const altitude = this.altitudeAboveEarth(ship);
        if (this.ignited && altitude > this.opts.liftoffHandoffAltitude) {
          this.transitionTo("cruise");
        }
        break;
      }
      case "cruise": {
        const range = this.rangeToDestination(ship);
        if (range < this.opts.approachDistance) {
          this.transitionTo("approach");
        }
        break;
      }
      case "approach": {
        const aglDest = this.altitudeAboveDestination(ship);
        if (aglDest < this.opts.touchdownAltitude) {
          this.transitionTo("touchdown");
        }
        // Allow drifting back if the player overshoots and re-cruises.
        const range = this.rangeToDestination(ship);
        if (range > this.opts.approachDistance * 1.4) {
          this.transitionTo("cruise");
        }
        break;
      }
      case "touchdown": {
        const aglDest = this.altitudeAboveDestination(ship);
        const speed = ship.velocity.length();
        if (
          aglDest < this.opts.touchdownAgl &&
          speed < this.opts.touchdownSpeed
        ) {
          this.transitionTo("landed");
        }
        // Climb back out of touchdown if the player aborts and gains altitude.
        if (aglDest > this.opts.touchdownAltitude * 1.4) {
          this.transitionTo("approach");
        }
        break;
      }
      case "landed":
        break;
    }
    return this._phase;
  }

  private transitionTo(next: MissionPhase): void {
    if (next === this._phase) return;
    const prev = this._phase;
    this._phase = next;
    this.events.onPhaseChange?.(next, prev);
  }

  /** Force a phase. Used by hard resets / debug tooling. */
  forcePhase(phase: MissionPhase): void {
    this.transitionTo(phase);
  }
}
