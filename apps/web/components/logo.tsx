export function Logo({ className }: { className?: string }) {
  return (
    <svg
      aria-labelledby="stratasync-logo-title"
      className={className}
      fill="none"
      role="img"
      viewBox="0 0 1000 1000"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id="stratasync-logo-title">Strata Sync</title>
      <rect fill="currentColor" height="1000" rx="167" width="1000" />
      <rect
        className="fill-background"
        height="133"
        rx="67"
        width="667"
        x="167"
        y="200"
      />
      <rect
        className="fill-background"
        height="133"
        rx="67"
        width="500"
        x="167"
        y="433"
      />
      <rect
        className="fill-background"
        height="133"
        rx="67"
        width="333"
        x="167"
        y="667"
      />
    </svg>
  );
}
