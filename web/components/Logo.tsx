export function Logo() {
  return (
    <svg
      className="mark"
      width="96"
      height="96"
      viewBox="0 0 256 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Devloop"
    >
      <defs>
        <linearGradient id="flow" x1="82" y1="80" x2="186" y2="196" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#56d4dd" />
          <stop offset="1" stopColor="#588cff" />
        </linearGradient>
      </defs>
      <path d="M 174 56 L 174 196" stroke="url(#flow)" strokeWidth="24" strokeLinecap="round" />
      <circle cx="128" cy="150" r="46" stroke="url(#flow)" strokeWidth="24" fill="none" />
      <circle cx="128" cy="150" r="15" fill="#ffd33d" />
    </svg>
  );
}
