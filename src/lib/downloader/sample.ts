/** Public-domain / freely usable sample sources for first-run demos. */
export const SAMPLE_PAGES = [
  {
    id: "picsum",
    label: "Sample stills (Lorem Picsum)",
    url: "https://picsum.photos/v2/list?page=2&limit=16",
    hint: "JSON photo API — good for testing the full pipeline",
  },
  {
    id: "direct",
    label: "Direct media URLs",
    url: [
      "https://picsum.photos/id/1015/1200/800.jpg",
      "https://picsum.photos/id/1025/1200/800.jpg",
      "https://picsum.photos/id/1039/1200/800.jpg",
      "https://picsum.photos/id/1043/1200/800.jpg",
    ].join("\n"),
    hint: "Skip crawl — resolve and download immediately",
  },
];
