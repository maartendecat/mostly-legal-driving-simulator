# The police: analysis (Part A5)

How the police should behave, what we need to build for it, and the decisions taken (§9). This is
the plan, not a description of what's in the game: what exists today is in
[DESIGN.md §12](DESIGN.md#12-police).

---

## 1. Where we are

Already built (the first slice, after playtest feedback):

- Police cars drive around in the traffic (2 per room), cops patrol on foot (6).
- **One wanted level.** Ramming a police car, hurting a cop or a police car, or stealing a police
  car makes you wanted at once, wherever the police are.
- Police cars within 20 blocks chase you along the roads; once you stop, both cops jump out. Cops
  on foot within 15 blocks run at you. A cop who reaches you (on foot, or in a stopped car) arrests
  you: **BUSTED**, weapons gone, back 3 s later.
- 30 s out of police sight and they give up. Dying clears your record.

What's missing compared to what you asked for: crimes of different weight (minor ones only noticed
when the police see them, major ones bringing a proactive response), a response that grows, the
army with tanks and helicopters, and the police as an option per game.

## 2. What GTA2 did (roughly)

- A wanted level shown as up to six cop heads.
- Crimes only counted when a cop saw them; hurting the police counted double.
- The response grew with the level: cops trying to arrest you, then cops shooting, then SWAT
  vans, then FBI agents, and at the top the army with tanks.
- The level dropped slowly while the police couldn't see you. Spray shops and "cop bribe" pickups
  took it down quickly.
- Busted: your weapons were gone (and in single player, part of your money).

We follow that shape, with three differences for our game: it's **multiplayer deathmatch**, so the
police must not take over the match; we add **helicopters**, which GTA2 didn't have; and we keep it
**an option** per room.

## 3. The heat model

Each player gets **heat**, a number. Crimes add heat; heat sets the **wanted level** (stars). This
lets small crimes add up while a single big one jumps straight to a higher level.

| Level | Heat | Shown |
|---|---|---|
| 0 | 0–9 | nothing |
| 1 ★ | 10+ | |
| 2 ★★ | 30+ | |
| 3 ★★★ | 60+ | |
| 4 ★★★★ | 100+ | |
| 5 ★★★★★ | 150+ | |
| 6 army | 220+, or a long chase (see §5) | flashing |

### Crimes

Two kinds, as you described:

- **Minor crimes only count when the police see them:** a cop on foot or a police car within
  12 blocks with a clear line of sight (the same "seen" check we already use for losing the
  police).
- **Major crimes are always reported**, wherever they happen: the police come looking.

| Crime | Kind | Heat |
|---|---|---|
| Firing a gun (seen) | minor | 2 per second of firing |
| Hitting someone with a car, not fatally (seen) | minor | 5 |
| Stealing a car with a driver in it (seen) | minor | 10 |
| Wrecking a civilian car (seen) | minor | 10 |
| Killing a pedestrian or a gang member (seen) | minor | 15 |
| Ramming a police car, hurting a cop or a police car | major | 10 (today's crimes: level 1) |
| Stealing a police car | major | 20 |
| Killing a cop | major | 40 |
| Wrecking a police car | major | 40 |
| Killing a SWAT officer or soldier, wrecking a SWAT van | major | 60 |
| Destroying a tank or helicopter | major | 100 |

Killing another player is **not** a crime: that's the game, and the police shouldn't punish
playing it (decided, §9). Gang members and other city people never commit crimes in the police's
eyes: the police only deal with players. That keeps the system understandable, and the city calm.

### Losing heat

- **Out of sight:** after 10 s without the police seeing you, heat drains at a rate that takes
  about 15 s per level, so level 1 is gone in about 25 s (today: 30 s), level 3 in about 55 s.
  While any police unit can see you, nothing drains.
- **Busted or dead:** heat back to 0.
- **Cop bribe crates** (new pickup, rare): one level down at once.
- Spray shops (drive into a garage, new colour, heat back to 0): not for now (decided, §9).

## 4. The response per level

All units arrive from out of sight, like traffic and fire trucks. They're added on top of the
normal police and removed again (out of sight) once nobody's wanted.

| Level | Who comes | What they do |
|---|---|---|
| 1 | the police cars and cops already nearby (20 / 15 blocks) | try to arrest you (as today) |
| 2 | + 2 extra police cars, from anywhere in the city | arrest; cops shoot back if you shoot at them |
| 3 | + 2 more police cars | cops shoot on sight; police cars ram your car; roadblocks ahead of you |
| 4 | + a SWAT van (4 officers with machine guns) | SWAT gets out near you and shoots; vans are heavy and bullet-resistant |
| 5 | + a second SWAT van, police cars everywhere | as level 4, more of them |
| 6 | **the army:** a tank, soldiers in a truck, a helicopter | tank cannon (rocket-like shells), soldiers with machine guns, helicopter overhead with a machine gun |

**Arrests** stay possible up to level 3: a cop who reaches you while you're on foot or stopped.
From level 4 they shoot to kill rather than arrest. Arresting takes **one second of contact**
("cuffing") during which you can still break away by moving (or driving off), instead of today's
instant arrest. That makes escapes possible and arrests feel deliberate (decided, §9).

**Police shooting** reuses the gang members' shooting: aim for half a second, then fire, with
some inaccuracy. Level 2–3 cops use pistols, SWAT and soldiers machine guns. Police bullets
hitting bystanders don't count against anyone.

**Roadblocks** (level 3+): two police cars parked across the road a couple of intersections ahead
of a suspect who's driving, using the road path we already compute. Cops stand next to them.

## 5. The army

"After a while, the army is called":

- Reaching 220 heat calls it. So does **a long chase**: 90 s in a row at level 4 or 5 while the
  police can see you gets you to level 6. A long, bloody chase ends with the army, as you asked.
- **Tank:** slow (top speed about 5), very heavy, 1,000 health; bullets barely scratch it (a
  tenth of their damage), rockets do. The turret turns on its own and fires a shell (a rocket)
  every 3 s at its target within 15 blocks in plain sight. It flattens cars it drives into.
- **Soldiers:** arrive in an army truck (the Car Kit's truck, olive green), 4 of them, machine guns.
- **Helicopter:** flies over buildings, so it always gets to you. It hovers near the target,
  circles, and fires machine-gun bursts. It can be shot down: rockets, or a lot of bullets
  (300 health). When it's shot down it falls and explodes.
- **Leaving:** the army stays until you've dropped below level 4, then drives or flies away.

What this needs that we don't have:

1. **Mass in car collisions.** Today every car is equally heavy: a sedan would push a tank around.
   This is already on the backlog (car handling); the army needs it first.
2. **A turret** that aims separately from the vehicle, and shells.
3. **Flying vehicles:** a new kind of entity with height. It doesn't collide with buildings or cars
   and is drawn above everything. It needs to be added to snapshots, deltas and the client.
4. **Art:** the Car Kit has no tank or helicopter: we'll look for CC0 models and download them
   (decided, §9).

## 6. Multiplayer

- **Several wanted players:** each unit goes after the nearest wanted player it can reach. The
  extra units of each level are counted **per player**, with a cap per room (say at most 8 extra
  police cars, 2 SWAT vans, 1 tank, 1 helicopter), so a room with four wanted players doesn't
  grind to a halt.
- **Everyone sees who's wanted:** stars next to the name tags and on the arrows, so you can lure
  the police towards someone else, or keep away from a player with the army on their tail.
- **Credit:** players killed by the police (or the army) died in an accident: a death, nobody's
  frag, as with gang members now.
- **Points mode:** killing cops is worth 50 points today. With escalation that could become a way
  to farm points (the army brings plenty of targets). Proposal: police units are worth points only
  up to level 3, nothing beyond.
- **Busted in each mode:** a death on the scoreboard in all modes (as now); in Points mode also
  −250 points (decided, §9); in Tag, "it" stays "it".
- **Respawning:** your heat is 0 when you come back, so the police never camp a spawn point.

## 7. The option per game

- When creating a room: **Police: on / on, no army / off**, defaulting to **on, with the army**
  (decided, §9). Off means no cops or police cars at all; "no army" stops at level 5.
- The default room: the same, from an environment variable (`POLICE=on|noarmy|off`, default `on`).
- Offline play: on.

## 8. How we'd build it

In steps, each one playable and tested on its own:

1. **Heat and levels:** the crime list, minor crimes only when seen, heat draining when unseen,
   stars in the HUD and next to name tags, a cuffing delay for arrests, the room option, cop
   bribe crates, and −250 points when busted in Points mode. Responses for levels 1–3: extra police cars, cops shooting, police cars ramming.
2. **Roadblocks and SWAT:** roadblocks at level 3, SWAT vans at levels 4–5, smarter chasing
   (avoiding other cars).
3. **The army on the ground:** mass in car collisions, the tank with its turret, soldiers, and
   escalation by time.
4. **The helicopter:** flying entities end to end (simulation, network, drawing).
Steps 1 and 2 are about as big as the gangs were. Steps 3 and 4 are bigger, mostly because of
the new physics and the new entity type.

## 9. Decisions

Taken after reviewing this analysis:

1. **Killing other players is not a crime.** The police don't get involved in the deathmatch itself.
2. **Busted in Points mode costs 250 points** (and counts as a death, as in every mode).
3. **Arrests take one second of contact**, during which you can break away.
4. **Losing heat:** waiting it out, and **cop bribe crates**. No spray shops for now.
5. **The army's art:** CC0 models for the tank and the helicopter, downloaded (sources to be
   found and approved when we get to step 3).
6. **New rooms:** police **and army on** by default.

## 10. Later: a co-op mode against the police

A fourth game mode (TODO, not part of A5): **all players together against the police**, lasting as
long as possible. Everyone starts wanted and the heat keeps rising over time, so the army comes
sooner or later; players can't hurt each other. The match ends when everyone has been busted or
killed (perhaps with a limited number of lives each), and the score is how long the team held out,
with a best time per city. It needs the full police (steps 1–4) first.
