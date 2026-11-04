/**
 * v26: launch-on-post templates, the five tiles in the builder: Founder announcements, Breaking news, Image memes,
 * Product launches and Custom. A template fills the triggers and the coin settings with sensible values; everything
 * stays editable. None of them change the honesty rules (the disclaimer, the X link, one coin per post).
 */
import type { LaunchOnPostRule, LaunchTemplateId } from "./onpost.js";

export interface LaunchTemplate { id: LaunchTemplateId; name: string; blurb: string; /** what it sets, in a few words (the tile's mono line) */ sets: string; apply: Partial<Pick<LaunchOnPostRule, "trigger" | "coin" | "mode" | "clash">> }

type Trig = LaunchOnPostRule["trigger"];
type Coin = LaunchOnPostRule["coin"];

export const LAUNCH_TEMPLATES: LaunchTemplate[] = [
  {
    id: "founder", name: "Founder announcements", blurb: "A founder you follow announces something new.", sets: "\"launching\", \"introducing\" · no CAs · literal names",
    apply: { trigger: { handles: [], requireImage: false, media: "any", keywords: ["launching", "introducing", "announcing", "we built", "today we"], exclude: ["giveaway", "airdrop"], contract: "forbid" } as Trig, coin: { naming: "model", style: "literal" } as Coin },
  },
  {
    id: "breaking", name: "Breaking news", blurb: "News accounts, only once a post takes off.", sets: "\"breaking\", \"just in\" · 500 likes in 120 s · one per story",
    apply: { trigger: { handles: [], requireImage: false, media: "any", keywords: ["breaking", "just in", "confirmed"], velocity: { likes: 500, withinSec: 120, waitSec: 120 }, dedupe: { topic: true, windowMin: 30, similarity: 0.5 } } as Trig, coin: { naming: "model", style: "short" } as Coin },
  },
  {
    id: "memes", name: "Image memes", blurb: "Picture posts, named with a pun, the image cropped square.", sets: "picture posts · punny names · square crop",
    apply: { trigger: { handles: [], requireImage: true, media: "image" } as Trig, coin: { naming: "model", style: "punny", image: "post", crop: true } as Coin },
  },
  {
    id: "product", name: "Product launches", blurb: "A product ships or opens up.", sets: "\"out now\", \"shipping\" · picture or video · literal names",
    apply: { trigger: { handles: [], requireImage: false, media: "image-or-video", keywords: ["now available", "out now", "shipping", "open beta", "public beta"] } as Trig, coin: { naming: "model", style: "literal" } as Coin },
  },
  {
    id: "custom", name: "Custom", blurb: "Start from the defaults and set everything yourself.", sets: "any post · short names · Confirm mode",
    apply: {},
  },
];

/** A new rule's settings with a template applied on top (triggers and coin merged, handles kept). */
export function applyTemplate(r: LaunchOnPostRule, id: LaunchTemplateId): LaunchOnPostRule {
  const t = LAUNCH_TEMPLATES.find((x) => x.id === id);
  if (!t) return r;
  return {
    ...r, template: id,
    trigger: { ...r.trigger, ...t.apply.trigger, handles: r.trigger.handles, off: r.trigger.off },
    coin: { ...r.coin, ...t.apply.coin, links: r.coin.links },
    ...(t.apply.mode ? { mode: t.apply.mode } : {}),
    ...(t.apply.clash ? { clash: { ...r.clash, ...t.apply.clash } } : {}),
  };
}
