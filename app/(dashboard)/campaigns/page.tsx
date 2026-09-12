import Link from "next/link";

const channels = [
  {
    href: "/campaigns/instagram",
    title: "Instagram Campaigns",
    description: "Turn Instagram comments into private replies and optional public responses.",
    badge: "DM automation",
  },
  {
    href: "/campaigns/threads",
    title: "Threads Campaigns",
    description: "Detect keyword replies across your post conversations and answer publicly.",
    badge: "Public replies",
  },
];

export default function CampaignChannelsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Channels</p>
        <h1 className="mt-2 text-3xl font-black text-foreground">Campaigns</h1>
        <p className="mt-2 text-sm text-muted">Choose where you want OpenReply to listen and respond.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {channels.map((channel) => (
          <Link
            key={channel.href}
            href={channel.href}
            className="panel group rounded p-6 transition hover:-translate-y-0.5 hover:border-accent/40"
          >
            <span className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
              {channel.badge}
            </span>
            <h2 className="mt-5 text-xl font-bold text-foreground group-hover:text-accent">{channel.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{channel.description}</p>
            <p className="mt-6 text-sm font-semibold text-accent">Open campaigns →</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
