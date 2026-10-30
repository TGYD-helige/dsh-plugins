export type AdmissionRelease = (onCurrent?: () => void) => void;
export interface Admission {
  ready: Promise<void>;
  release: AdmissionRelease;
}

/** Small keyed FIFO gate. Cleanup runs only when the releasing tail is still current. */
export class AdmissionGate {
  private readonly tails = new Map<string, Promise<void>>();

  acquire(key: string): Admission {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    let released = false;
    return {
      ready: previous,
      release: (onCurrent) => {
        if (released) return;
        released = true;
        open();
        if (this.tails.get(key) !== tail) return;
        this.tails.delete(key);
        onCurrent?.();
      },
    };
  }
}
