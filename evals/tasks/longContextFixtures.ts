export interface Fixture {
  text: string;
  lineCount: number;
}

function toFixture(lines: string[]): Fixture {
  return { text: lines.join("\n"), lineCount: lines.length };
}

export function buildConfigFixture(): Fixture {
  const lines: string[] = [
    "# Omni eval fixture: synthetic service configuration",
    "# (generated for evals/tasks/long-context.tasks.ts, not a real config)",
  ];
  const total = 115;
  const needleAt = Math.floor(total / 2);
  for (let i = 1; i <= total; i++) {
    lines.push(`SERVICE_${String(i).padStart(3, "0")}_TIMEOUT_MS=${3000 + i * 17}`);
    lines.push(`SERVICE_${String(i).padStart(3, "0")}_RETRIES=${1 + (i % 4)}`);
    lines.push(`SERVICE_${String(i).padStart(3, "0")}_ENDPOINT=https://svc-${i}.internal.example.com`);
    if (i === needleAt) {
      lines.push("MAX_RETRY_BACKOFF_MS=8742");
    }
  }
  lines.push("# end of generated config");
  return toFixture(lines);
}

export function buildSourceFixture(): Fixture {
  const lines: string[] = [
    "// Omni eval fixture: synthetic pricing-service source file",
    "// (generated for evals/tasks/long-context.tasks.ts, not real code)",
    "",
  ];
  const regionCodes = [
    "NE-1", "NE-2", "NE-3", "SW-4", "SW-5", "SE-6", "NW-7", "NW-8", "MW-9", "MW-10",
  ];
  const total = 95;
  const needleAt = Math.floor(total / 2);
  for (let i = 0; i < total; i++) {
    lines.push(`function calcFeeRegion${String(i).padStart(3, "0")}(amount) {`);
    lines.push(`  return Math.round(amount * 0.0${(i % 9) + 1} * 100) / 100;`);
    lines.push("}");
    lines.push("");
    if (i === needleAt) {
      lines.push("function computeShippingSurcharge(regionCode) {");
      lines.push("  const surcharges = {");
      for (const code of regionCodes) {
        const value = code === "NW-7" ? 42.75 : Number((code.length * 1.5).toFixed(2));
        lines.push(`    "${code}": ${value},`);
      }
      lines.push("  };");
      lines.push("  return surcharges[regionCode] ?? 0;");
      lines.push("}");
      lines.push("");
    }
  }
  return toFixture(lines);
}

export function buildLogFixture(): Fixture {
  const lines: string[] = [];
  const endpoints = [
    "/api/v2/orders",
    "/api/v2/customers",
    "/api/v2/catalog/search",
    "/api/v2/payments/charge",
  ];
  const total = 320;
  const needleAt = Math.floor(total / 2);
  const baseTime = Date.parse("2026-03-14T09:00:00Z");
  for (let i = 0; i < total; i++) {
    const ts = new Date(baseTime + i * 41_000).toISOString();
    if (i === needleAt) {
      lines.push(`${ts} ERROR 503 /api/v2/inventory/sync - upstream timeout after 30000ms`);
    } else {
      const endpoint = endpoints[i % endpoints.length];
      lines.push(`${ts} INFO 200 ${endpoint} - ok (${40 + (i % 60)}ms)`);
    }
  }
  return toFixture(lines);
}

export function buildTranscriptFixture(): Fixture {
  const speakers = ["Marcus", "Devon", "Aisha", "Yuki"];
  const lines: string[] = ["Migration planning sync -- transcript (generated fixture)", ""];
  const total = 305;
  const needleAt = Math.floor(total / 2);
  for (let i = 0; i < total; i++) {
    if (i === needleAt) {
      lines.push(
        "Priya: We'll need 14 additional servers provisioned by Friday to handle the migration load."
      );
      continue;
    }
    const speaker = speakers[i % speakers.length];
    lines.push(`${speaker}: Status update ${i} -- no blockers, on track for the current milestone.`);
  }
  return toFixture(lines);
}
