export class PayloadPrivacy {
  constructor(private privacyConfig: { secrets: string[]; redactFields?: string[] }) {}
  /** Clone telemetry only; never mutate harness-owned messages or tool results. */
  mask<T>(data: T): T {
    const secrets = [...this.privacyConfig.secrets].filter(Boolean);
    const fields = new Set(this.privacyConfig.redactFields?.map((key) => key.toLowerCase()));
    const seen = new WeakSet<object>();
    const redactText = (text: string): string => {
      const markedRanges: Array<[number, number]> = Array.from(
        text.matchAll(/\[REDACTED\]/g),
        (match) => [match.index, match.index + match[0].length],
      );
      const ranges: Array<[number, number]> = [];
      let markerIndex = 0;
      const addRange = (start: number, stop: number) => {
        // Existing markers are atomic: a second mask must never expand them.
        // Walk the sorted marker list once instead of rescanning it per match.
        while (markerIndex < markedRanges.length && markedRanges[markerIndex][1] <= start)
          markerIndex += 1;
        if (
          markerIndex < markedRanges.length &&
          start < markedRanges[markerIndex][1] &&
          stop > markedRanges[markerIndex][0]
        )
          return;
        ranges.push([start, stop]);
      };
      for (const match of text.matchAll(/(?:pk|sk)-lf-[\w-]+/g))
        addRange(match.index, match.index + match[0].length);
      for (const secret of secrets) {
        // Each independent scan starts at the first marker. Do not reset for
        // every match, or a large marker list becomes quadratic again.
        markerIndex = 0;
        for (
          let index = text.indexOf(secret);
          index !== -1;
          index = text.indexOf(secret, index + 1)
        ) {
          addRange(index, index + secret.length);
        }
      }
      let output = '';
      let end = 0;
      // Match the original text once, merging overlap before changing any bytes.
      for (const [start, stop] of ranges.sort((a, b) => a[0] - b[0])) {
        if (start >= end) output += `${text.slice(end, start)}[REDACTED]`;
        end = Math.max(end, stop);
      }
      return output + text.slice(end);
    };
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string') {
        // Tool-call arguments and SDK attributes may themselves be JSON text.
        if (fields.size && /^\s*[[{]/.test(value)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            /* not JSON */
          }
          if (parsed !== undefined) {
            const masked = JSON.stringify(redact(parsed));
            if (masked !== JSON.stringify(parsed)) return masked;
          }
        }
        return redactText(value);
      }
      if (!value || typeof value !== 'object' || value instanceof Date) return value;
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      const result = Array.isArray(value)
        ? value.map(redact)
        : Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              redact(key),
              fields.has(key.toLowerCase()) ? '[REDACTED]' : redact(child),
            ]),
          );
      seen.delete(value);
      return result;
    };
    try {
      return redact(data) as T;
    } catch (error) {
      console.error('[dsh-langfuse] redaction failed:', error);
      return '[REDACTED]' as T;
    }
  }
}
