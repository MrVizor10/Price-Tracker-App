
import { Toaster } from "sonner";
import "./globals.css";


export const metadata = {
  title: "My Deal Drop App",
  description: "",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster richColors/>
      </body>
    </html>
  );
}
