import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://devloop.build/",
      changeFrequency: "weekly",
      priority: 1.0,
    },
  ];
}
