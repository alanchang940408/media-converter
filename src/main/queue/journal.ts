// Undo journal for move / rename jobs (userData file-ops-journal.json). Copies are not journaled.
// One record per batch of file operations: entries are appended in completion order while the batch runs.

export interface FileOpJournalEntry {
  /** Where the file was before. */
  from: string
  /** Where the job put it. */
  to: string
  op: 'move' | 'rename'
}

export interface FileOpJournalRun {
  id: string
  startedAt: number
  /** Set when the batch ended; open records (still running, or interrupted by a crash) have none. */
  finishedAt?: number
  entries: FileOpJournalEntry[]
}

export interface FileOpJournal {
  version: 1
  runs: FileOpJournalRun[]
}

/** What the queue needs from the journal's persistence (JsonStore satisfies it). */
export interface JournalStore {
  get(): FileOpJournal
  save(): void
  flush(): Promise<void>
}

/** Oldest records are dropped beyond this. */
export const MAX_JOURNAL_RUNS = 20

export function emptyJournal(): FileOpJournal {
  return { version: 1, runs: [] }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Validate a journal read from disk (null → defaults). */
export function parseJournal(raw: unknown): FileOpJournal | null {
  if (!isObj(raw) || !Array.isArray(raw.runs)) return null
  const runs: FileOpJournalRun[] = []
  for (const r of raw.runs) {
    if (!isObj(r) || typeof r.id !== 'string' || !Array.isArray(r.entries)) continue
    const entries = r.entries.filter(
      (e): e is FileOpJournalEntry =>
        isObj(e) && typeof e.from === 'string' && typeof e.to === 'string' && (e.op === 'move' || e.op === 'rename'),
    )
    runs.push({
      id: r.id,
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
      ...(typeof r.finishedAt === 'number' ? { finishedAt: r.finishedAt } : {}),
      entries: entries.map((e) => ({ from: e.from, to: e.to, op: e.op })),
    })
  }
  return { version: 1, runs: runs.slice(-MAX_JOURNAL_RUNS) }
}

/** In-memory journal (tests, or when no persistent store is given). */
export class MemoryJournal implements JournalStore {
  private data: FileOpJournal = emptyJournal()
  get(): FileOpJournal {
    return this.data
  }
  save(): void {
    /* nothing to persist */
  }
  async flush(): Promise<void> {
    /* nothing to persist */
  }
}
