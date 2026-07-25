export interface CliArgs {
  /** bench mode: 'startup' | 'nav' | 'dns' | 'profile' */
  bench?: string;
  url?: string;
  out?: string;
  flagSet?: string;
  profileDir?: string;
  dns?: string;
  warmup?: string;
  spare?: string;
  repeat?: string;
  hidden?: boolean;
}

/** Parses --key=value and --key value style args; bare --key becomes true. */
export function parseArgs(argv: string[]): CliArgs {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[camel(a.slice(2, eq))] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[camel(a.slice(2))] = next;
        i++;
      } else {
        out[camel(a.slice(2))] = true;
      }
    }
  }
  return out as CliArgs;
}

function camel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
