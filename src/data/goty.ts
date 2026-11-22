export interface GotyRunnerUp {
  title: string;
  platform: string;
  category?: string;
}

export interface GotyYear {
  year: number;
  winner: {
    title: string;
    platform: string;
    developer: string;
    cover: string;
    quote: string;
    reflection: string;
    journalHref?: string;
  };
  honorableMentions: GotyRunnerUp[];
}

// Data arsip GOTY personal (urutkan dari tahun terbaru)
export const gotyArchive: GotyYear[] = [
  {
    year: 2025,
    winner: {
      title: 'Clair Obscur: Expedition 33',
      platform: 'PC / PS5',
      developer: 'Sandfall Interactive',
      cover: '/images.jpg',
      quote: 'Turn-based combat yang terasa seperti tarian, dibalut melankolia lukisan Belle Époque.',
      reflection:
        'Bukan sekadar penghormatan untuk JRPG klasik, tetapi pembuktian bahwa sistem parrying real-time bisa menyatu dengan narasi puitis yang membekas lama setelah kredit bergulir.',
      journalHref: '/journal',
    },
    honorableMentions: [
      { title: 'Death Stranding 2: On The Beach', platform: 'PS5', category: 'Best Atmosphere' },
      { title: 'Hades II', platform: 'PC', category: 'Best Gameplay Loop' },
      { title: 'Monster Hunter Wilds', platform: 'PC', category: 'Most Hours Played' },
    ],
  },
  {
    year: 2024,
    winner: {
      title: 'Metaphor: ReFantazio',
      platform: 'PC / PS5',
      developer: 'Studio Zero',
      cover: '/images.jpg',
      quote: 'Sebuah perjalanan fantasi politik tentang kekuatan cerita dan kecemasan manusia.',
      reflection:
        'Struktur kalender dan sistem Archetype membuat setiap keputusan harian terasa berbobot. Musik dan arah seninya membentuk identitas yang sulit dilupakan.',
    },
    honorableMentions: [
      { title: 'Astro Bot', platform: 'PS5', category: 'Purest Joy' },
      { title: 'Balatro', platform: 'PC / Switch', category: 'Best Indie' },
      { title: 'Silent Hill 2 Remake', platform: 'PC / PS5', category: 'Best Sound Design' },
    ],
  },
  {
    year: 2023,
    winner: {
      title: "Baldur's Gate 3",
      platform: 'PC',
      developer: 'Larian Studios',
      cover: '/images.jpg',
      quote: 'Standar baru kebebasan bercerita dalam medium interaktif.',
      reflection:
        'Setiap sudut Forgotten Realms terasa reaktif terhadap pilihan paling konyol sekalipun. Petualangan bersama para companion di camp menjadi kenangan gaming terbaik dekade ini.',
    },
    honorableMentions: [
      { title: 'Alan Wake 2', platform: 'PC', category: 'Best Narrative Direction' },
      { title: 'The Legend of Zelda: Tears of the Kingdom', platform: 'Switch', category: 'Best Exploration' },
    ],
  },
];
