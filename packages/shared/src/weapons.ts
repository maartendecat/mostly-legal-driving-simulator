export type ProjectileKind = 'bullet' | 'rocket';

/**
 * Weapon stats. Like cars, visuals live in asset packs; this is only what the simulation needs.
 * Distances are in blocks, speeds in blocks per second.
 */
export interface WeaponDef {
  id: string;
  name: string;
  /** Ticks between shots while fire is held. */
  cooldownTicks: number;
  projectile: ProjectileKind;
  speed: number;
  /** How far a projectile flies before it disappears (bullets) or explodes (rockets). */
  range: number;
  /** Maximum random deviation per shot, in radians. */
  spread: number;
  /** Ammo gained from one pickup. */
  pickupAmmo: number;
  maxAmmo: number;
  /** Damage to a ped hit directly, or at the centre of the blast for explosives. */
  damage: number;
  /** Explosion radius on impact; 0 for plain bullets. */
  blastRadius: number;
}

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'Pistol', cooldownTicks: 18, projectile: 'bullet', speed: 22, range: 14,
    spread: 0.01, pickupAmmo: 30, maxAmmo: 99, damage: 25, blastRadius: 0,
  },
  machineGun: {
    id: 'machineGun', name: 'Machine gun', cooldownTicks: 5, projectile: 'bullet', speed: 24, range: 14,
    spread: 0.07, pickupAmmo: 80, maxAmmo: 300, damage: 12, blastRadius: 0,
  },
  rocketLauncher: {
    id: 'rocketLauncher', name: 'Rocket launcher', cooldownTicks: 50, projectile: 'rocket', speed: 11, range: 22,
    spread: 0, pickupAmmo: 5, maxAmmo: 20, damage: 150, blastRadius: 1.8,
  },
  /** A tank's cannon (see army.ts): never a pickup, never in anyone's hands. */
  tankShell: {
    id: 'tankShell', name: 'Tank shell', cooldownTicks: 150, projectile: 'rocket', speed: 14, range: 18,
    spread: 0.02, pickupAmmo: 0, maxAmmo: 0, damage: 160, blastRadius: 2.2,
  },
} as const satisfies Record<string, WeaponDef>;

export type WeaponId = keyof typeof WEAPONS;

/** Also the order Z/X cycle through. */
export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];
