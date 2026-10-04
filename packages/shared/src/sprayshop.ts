import { isDead } from './damage';
import { randomPick } from './math';
import { clearHeat } from './police';
import { CAR_COLORS, carSpeed, type World } from './world';
import { secondsToTicks } from './time';

/**
 * Spray shops (see BlockMap.sprayShops): drive a car into the bay in front of the garage and
 * hold still for a moment, and it comes out in a new colour. If the police were after you, they've
 * lost you: all your stars are gone. Police and army vehicles don't get painted.
 */

/** Holding still in the bay for this long gets you a new paint job... */
export const SPRAY_TICKS = secondsToTicks(1.5);
/** ...with the car's middle this close to the bay's, going no faster than this. */
const BAY_RADIUS = 0.8;
const MAX_SPEED = 0.8;

/** Once per tick: cars waiting in the bays get painted. `world.sprayProgress[i]` is shop i's. */
export function stepSprayShops(world: World): void {
  world.map.sprayShops.forEach((shop, i) => {
    let car;
    for (const candidate of world.cars.values()) {
      if (Math.hypot(candidate.x - shop.x, candidate.y - shop.y) < BAY_RADIUS) car = candidate;
    }
    const driver = car?.driverId == null ? undefined : world.peds.get(car.driverId);
    if (!car || !driver || driver.kind !== 'player' || isDead(driver) || car.police || car.wrecked || carSpeed(car) > MAX_SPEED) {
      world.sprayProgress[i] = 0;
      return;
    }
    world.sprayProgress[i] = (world.sprayProgress[i] ?? 0) + 1;
    if (world.sprayProgress[i]! < SPRAY_TICKS) return;
    world.sprayProgress[i] = -SPRAY_TICKS * 2; // not again right away
    car.color = randomPick(world, CAR_COLORS.filter((c) => c !== car.color));
    car.paintJobs++;
    const lostThem = clearHeat(world, driver);
    world.events.push({ type: 'sprayed', tick: world.tick, ownerId: driver.id, pedId: driver.id, lostThem, x: car.x, y: car.y });
  });
}
