import type { ImgHTMLAttributes } from "react";
import { useCmsMediaUrl } from "../hooks/useCmsMediaUrl";

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
};

/** img with CMS media URL resolution (CDN or Supabase fallback). Lazy by default; pass loading="eager" above the fold. */
export function CmsMediaImg({ src, loading = "lazy", ...rest }: Props) {
  const { resolve } = useCmsMediaUrl();
  return <img src={resolve(src)} loading={loading} {...rest} />;
}
