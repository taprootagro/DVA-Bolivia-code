import type { ImgHTMLAttributes } from "react";
import { useCmsMediaUrl } from "../hooks/useCmsMediaUrl";

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
};

/** img with CMS media URL resolution (CDN or Supabase fallback). */
export function CmsMediaImg({ src, ...rest }: Props) {
  const { resolve } = useCmsMediaUrl();
  return <img src={resolve(src)} {...rest} />;
}
