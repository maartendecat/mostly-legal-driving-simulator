const SHOW_MS = 2500;

/** A short message near the bottom of the screen that fades out by itself. */
export class Toast {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly element: HTMLElement) {}

  show(text: string): void {
    this.element.textContent = text;
    this.element.classList.add('visible');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.element.classList.remove('visible'), SHOW_MS);
  }
}
