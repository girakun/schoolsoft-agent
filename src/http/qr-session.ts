/** One in-memory, throttled QR challenge; late polls cannot finish another sign-in. */
import type { QrAuthorizationRequest } from "../core/index.js";

export class QrLoginSession {
  private svg: string;
  private nextPoll = 0;
  private inFlight?: Promise<void>;
  constructor(
    private readonly request: QrAuthorizationRequest,
    private readonly now: () => number,
    private readonly active: () => boolean,
    private readonly complete: (code: string) => void,
    private readonly failed: () => void,
  ) {
    this.svg = request.qrSvg;
  }
  image(): string | undefined {
    return this.active() ? this.svg : undefined;
  }
  async poll(): Promise<void> {
    if (!this.active() || this.now() < this.nextPoll) return;
    if (this.inFlight) return this.inFlight;
    this.nextPoll = this.now() + 3000;
    this.inFlight = this.request
      .poll()
      .then((result) => {
        if (!this.active()) return;
        if (result.code) this.complete(result.code);
        else if (result.qrSvg) this.svg = result.qrSvg;
      })
      .catch(() => {
        if (this.active()) this.failed();
      });
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }
}
