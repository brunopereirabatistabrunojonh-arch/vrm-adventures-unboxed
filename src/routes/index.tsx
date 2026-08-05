import { createFileRoute } from "@tanstack/react-router";
import Game from "@/components/Game";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VRM Hero — 3D Browser Game" },
      { name: "description", content: "Explore an open 3D world, fight enemies and survive as your VRM hero." },
      { property: "og:title", content: "VRM Hero — 3D Browser Game" },
      { property: "og:description", content: "Explore an open 3D world, fight enemies and survive as your VRM hero." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  return <Game />;
}
