import { twMerge } from "tailwind-merge";

export const cn = (...inputs: Parameters<typeof twMerge>): string =>
  twMerge(...inputs);
