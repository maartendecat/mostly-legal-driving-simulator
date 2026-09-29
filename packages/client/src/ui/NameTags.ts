export interface NameTag {
  id: number;
  text: string;
  /** Position in CSS pixels, relative to the tag container. */
  x: number;
  y: number;
}

/** HTML labels floating over other players. Plain DOM keeps text crisp at any zoom level. */
export class NameTags {
  private readonly elements = new Map<number, HTMLElement>();

  constructor(private readonly container: HTMLElement) {}

  update(tags: readonly NameTag[]): void {
    const seen = new Set<number>();
    for (const tag of tags) {
      seen.add(tag.id);
      let element = this.elements.get(tag.id);
      if (!element) {
        element = document.createElement('div');
        element.className = 'name-tag';
        this.container.appendChild(element);
        this.elements.set(tag.id, element);
      }
      if (element.textContent !== tag.text) element.textContent = tag.text;
      element.style.transform = `translate(${tag.x}px, ${tag.y}px) translate(-50%, -100%)`;
    }
    for (const [id, element] of this.elements) {
      if (!seen.has(id)) {
        element.remove();
        this.elements.delete(id);
      }
    }
  }
}
