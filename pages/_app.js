import "@/styles/globals.css";
import { AlertHost } from "@/components/ui/Alert";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Component {...pageProps} />
      <AlertHost />
    </>
  );
}
