import type { CollectionEntry } from "astro:content";

import { backlogGames, type BacklogGame } from "../data/backlog";

export type JournalEntry = CollectionEntry<"journal">;

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function gameForEntry(entry: JournalEntry): BacklogGame | undefined {
  // Prioritaskan ID eksplisit
  if (entry.data.gameId) {
    return backlogGames.find((game) => game.id === entry.data.gameId);
  }

  // Fallback untuk artikel lama, termasuk MOTHERED
  return backlogGames.find(
    (game) => normalize(game.title) === normalize(entry.data.game),
  );
}

export function journalsForGame(
  entries: JournalEntry[],
  gameId: string,
): JournalEntry[] {
  return entries
    .filter((entry) => gameForEntry(entry)?.id === gameId)
    .sort(
      (a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime(),
    );
}

export function sortJournals(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort(
    (a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime(),
  );
}

export function journalPath(entry: JournalEntry) {
  return `/journal/${encodeURIComponent(entry.id)}`;
}

export function franchisePath(franchise: string) {
  return `/backlog?franchise=${encodeURIComponent(franchise)}`;
}
