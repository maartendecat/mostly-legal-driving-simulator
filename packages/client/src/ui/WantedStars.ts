/**
 * The wanted level, always on screen at the top: six stars, outlined while empty, filled as the
 * police get more serious (the sixth, the army, in red). Gaining a star makes them flash for a
 * moment, as in GTA2.
 */
export class WantedStars {
  private readonly stars: HTMLElement[] = [];
  private level = 0;
  private flashUntil = 0;

  constructor(private readonly container: HTMLElement) {
    for (let i = 0; i < 6; i++) {
      const star = document.createElement('span');
      star.className = i === 5 ? 'star army' : 'star';
      star.textContent = '★';
      this.stars.push(star);
      container.append(star);
    }
    container.title = 'Wanted level';
  }

  update(level: number, now: number): void {
    if (level > this.level) this.flashUntil = now + 2000;
    this.level = level;
    this.stars.forEach((star, i) => star.classList.toggle('lit', i < level));
    this.container.classList.toggle('flash', now < this.flashUntil);
  }
}
