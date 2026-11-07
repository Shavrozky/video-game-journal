export type Platform = "PC" | "PS1" | "PS2" | "PS3" | "PS4" | "PS5" | "Switch";

export type BacklogStatus =
  | "Next"
  | "Queued"
  | "On Hold"
  | "Someday"
  | "Logged";

export type BacklogPriority = "High" | "Medium" | "Low";

export type Franchise = "Silent Hill" | "Resident Evil" | "Indie Horror";

export interface BacklogGame {
  id: string;
  registry: number;
  title: string;
  platform: Platform;
  year: number;
  cover?: string;
  franchise: Franchise;
  status: BacklogStatus;
  priority: BacklogPriority;
  genre: string;
  reason: string;
  estimatedTime?: string;
}

export const backlogGames: BacklogGame[] = [
  {
    id: "signalis",
    registry: 1,
    title: "SIGNALIS",
    platform: "PC",
    year: 2022,
    cover: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=500",
    franchise: "Indie Horror",
    status: "Next",
    priority: "High",
    genre: "Survival Horror",
    reason: "Retrofuturisme, isolasi, dan narasi psikologis yang berlapis.",
  },
  {
    id: "whos-lila",
    registry: 2,
    title: "Who's Lila?",
    platform: "PC",
    year: 2022,
    cover: "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=500",
    franchise: "Indie Horror",
    status: "Queued",
    priority: "High",
    genre: "Psychological Horror",
    reason: "Ekspresi wajah menjadi bagian dari mekanik interaksi.",
  },
  {
    id: "silent-hill-2",
    registry: 3,
    title: "Silent Hill 2 (2001)",
    platform: "PS2",
    year: 2001,
    franchise: "Silent Hill",
    status: "Queued",
    priority: "High",
    genre: "Psychological Horror",
    reason: "Rasa bersalah, kehilangan, kabut, dan simbolisme.",
  },
  {
    id: "crow-country",
    registry: 4,
    title: "Crow Country",
    platform: "PC",
    year: 2024,
    cover: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=500",
    franchise: "Indie Horror",
    status: "Someday",
    priority: "Medium",
    genre: "Survival Horror",
    reason: "Eksplorasi taman hiburan dengan estetika retro 3D.",
  },
  {
    id: "mouthwashing",
    registry: 5,
    title: "Mouthwashing",
    platform: "PC",
    year: 2024,
    cover: "https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=500",
    franchise: "Indie Horror",
    status: "Next",
    priority: "High",
    genre: "Psychological Horror",
    reason: "Narasi menekan dengan hubungan antarkarakter yang kompleks.",
  },
  {
    id: "paratopic",
    registry: 6,
    title: "Paratopic",
    platform: "PC",
    year: 2018,
    cover: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=500",
    franchise: "Indie Horror",
    status: "On Hold",
    priority: "Low",
    genre: "Experimental Horror",
    reason: "Eksperimen horor low-poly dan cerita nonlinier.",
  },
  {
    id: "mothered",
    registry: 7,
    title: "MOTHERED",
    platform: "PC",
    year: 2021,
    cover: "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=500",
    franchise: "Indie Horror",
    status: "Logged",
    priority: "Low",
    genre: "Psychological Horror",
    reason: "Memiliki Field Log tentang manekin, rutinitas, dan paranoia.",
  },

  // SILENT HILL SERIES

  {
    id: "silent-hill-1",
    registry: 8,
    title: "Silent Hill",
    platform: "PS1",
    year: 1999,
    franchise: "Silent Hill",
    status: "Queued",
    priority: "Medium",
    genre: "Psychological Horror",
    reason:
      "Kabut, keterbatasan visual, dan ketakutan terhadap sesuatu yang tidak terlihat.",
  },
  {
    id: "silent-hill-3",
    registry: 9,
    title: "Silent Hill 3",
    platform: "PS2",
    year: 2003,
    franchise: "Silent Hill",
    status: "Queued",
    priority: "Medium",
    genre: "Psychological Horror",
    reason: "Identitas Heather Mason dan ruang yang kehilangan rasa aman.",
  },
  {
    id: "silent-hill-4",
    registry: 10,
    title: "Silent Hill 4: The Room",
    platform: "PS2",
    year: 2004,
    franchise: "Silent Hill",
    status: "Someday",
    priority: "Medium",
    genre: "Psychological Horror",
    reason: "Apartemen sebagai tempat berlindung sekaligus sumber ancaman.",
  },
  {
    id: "silent-hill-2-remake",
    registry: 11,
    title: "Silent Hill 2 Remake",
    platform: "PS5",
    year: 2024,
    franchise: "Silent Hill",
    status: "Queued",
    priority: "Medium",
    genre: "Psychological Horror",
    reason: "Perbandingan atmosfer, kamera, dan ritme dengan versi 2001.",
  },

  // RESIDENT EVIL FRANCHISE

  {
    id: "resident-evil-1",
    registry: 12,
    title: "Resident Evil",
    platform: "PS1",
    year: 1996,
    franchise: "Resident Evil",
    status: "Queued",
    priority: "Medium",
    genre: "Survival Horror",
    reason:
      "Akar survival horror klasik dengan eksplorasi dan keterbatasan sumber daya.",
  },
  {
    id: "resident-evil-2-remake",
    registry: 13,
    title: "Resident Evil 2 Remake",
    platform: "PS4",
    year: 2019,
    franchise: "Resident Evil",
    status: "Queued",
    priority: "High",
    genre: "Survival Horror",
    reason: "Ketegangan lewat ruang, rute, musuh, dan manajemen amunisi.",
  },
  {
    id: "resident-evil-4",
    registry: 14,
    title: "Resident Evil 4 (2005)",
    platform: "PS2",
    year: 2005,
    franchise: "Resident Evil",
    status: "Someday",
    priority: "Medium",
    genre: "Action Horror",
    reason: "Perubahan desain survival horror menuju aksi yang lebih dominan.",
  },
  {
    id: "resident-evil-7",
    registry: 15,
    title: "Resident Evil 7: Biohazard",
    platform: "PC",
    year: 2017,
    franchise: "Resident Evil",
    status: "Queued",
    priority: "High",
    genre: "Survival Horror",
    reason: "Perspektif orang pertama, rumah terpencil, dan rasa terisolasi.",
  },
  {
    id: "resident-evil-village",
    registry: 16,
    title: "Resident Evil Village",
    platform: "PS5",
    year: 2021,
    franchise: "Resident Evil",
    status: "Someday",
    priority: "Medium",
    genre: "Survival / Action Horror",
    reason:
      "Eksplorasi variasi atmosfer, aksi, dan ancaman dalam satu permainan.",
  },
];

export const backlogPreview = backlogGames
  .filter((game) => game.status !== "Logged")
  .slice(0, 4);

export function findGame(id: string) {
  return backlogGames.find((game) => game.id === id);
}
