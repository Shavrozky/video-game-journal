import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const journalCollection = defineCollection({
  loader: glob({
    base: "./src/content/journal",
    pattern: "**/*.{md,mdx}",
  }),

  schema: z.object({
    title: z.string(),
    game: z.string(),

    // ID game harus sama dengan backlog.ts
    gameId: z.string().optional(),

    // session = pengalaman pribadi
    // overview = artikel pengantar/kurasi
    entryType: z.enum(["session", "overview"]).default("session"),

    excerpt: z.string().optional(),

    platform: z.enum(["PC", "PS1", "PS2", "PS3", "PS4", "PS5", "Switch"]),

    sessionTime: z.string(),
    playerCondition: z.string(),
    boxArtUrl: z.string().optional(),

    publishDate: z.coerce.date(),

    status: z.enum([
      "In Progress",
      "Cleared",
      "Abandoned",
      "Traumatized",
      "Masterpiece",
      "Confused",
      "Planned",
    ]),

    paranoia: z
      .array(
        z.object({
          label: z.string(),
          state: z.string(),
          level: z.number().min(0).max(100),
        }),
      )
      .optional(),
  }),
});

export const collections = {
  journal: journalCollection,
};
