/** One tick of player input. This is all a client will send to the server. */
export interface PlayerInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
  /** Handbrake in a car, jump on foot (GTA2's Space key). */
  handbrake: boolean;
  /** Enter or exit a vehicle. */
  enter: boolean;
  weaponNext: boolean;
  weaponPrev: boolean;
}

export const NO_INPUT: Readonly<PlayerInput> = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  fire: false,
  handbrake: false,
  enter: false,
  weaponNext: false,
  weaponPrev: false,
});
