import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { scrapeProduct } from "@/lib/firecrawl";
import { sendPriceDropAlert } from "@/lib/email";

export async function GET() {
  return NextResponse.json({
    message: "Price check endpoint is working. Use POST to trigger",
  });
}

export async function POST(request) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("*");

    if (productsError) throw productsError;

    console.log(`Found ${products.length} products to check`);

    const results = {
      total: products.length,
      updated: 0,
      failed: 0,
      priceChanges: 0,
      alertsSent: 0,
      errors: [],
    };

    for (const product of products) {
      let stage = "scrape";
      let priceUpdated = false;
      try {
        const productData = await scrapeProduct(product.url);

        const rawPrice = productData?.currentPrice;
        const newPrice = Number(rawPrice);
        if (
          rawPrice == null ||
          (typeof rawPrice !== "number" && typeof rawPrice !== "string") ||
          (typeof rawPrice === "string" && rawPrice.trim() === "") ||
          !Number.isFinite(newPrice) ||
          newPrice < 0
        ) {
          throw new Error("Scraper did not return a valid currentPrice");
        }

        const oldPrice = parseFloat(product.current_price);

        stage = "update_product";
        const { data: updatedProduct, error: updateError } = await supabase
          .from("products")
          .update({
            current_price: newPrice,
            currency: productData.currencyCode || product.currency,
            name: productData.productName || product.name,
            image_url: productData.productImageUrl || product.image_url,
            updated_at: new Date().toISOString(),
          })
          .eq("id", product.id)
          .select("id")
          .single();

        if (updateError) throw updateError;
        if (!updatedProduct) throw new Error("Product update returned no row");
        priceUpdated = true;
        results.updated++;

        if (oldPrice !== newPrice) {
          stage = "insert_history";
          const { error: historyError } = await supabase.from("price_history").insert({
            product_id: product.id,
            price: newPrice,
            currency: productData.currencyCode || product.currency,
          });

          if (historyError) throw historyError;

          results.priceChanges++;

          if (newPrice < oldPrice) {
            stage = "lookup_user";
            const {
              data: { user },
              error: userError,
            } = await supabase.auth.admin.getUserById(product.user_id);

            if (userError) throw userError;

            if (user?.email) {
              stage = "send_alert";
              const emailResult = await sendPriceDropAlert(
                user.email,
                product,
                oldPrice,
                newPrice,
              );

              if (emailResult.success) {
                results.alertsSent++;
              } else {
                throw new Error(
                  emailResult.error?.message || emailResult.error || "Price drop alert failed",
                );
              }
            }
          }
        }

      } catch (error) {
        console.error(`Error processing product ${product.id}:`, error);
        results.failed++;
        results.errors.push({
          productId: product.id,
          stage,
          priceUpdated,
          message: error.message || "Unknown product processing error",
        });
      }
    }

    return NextResponse.json(results);
  } catch (error) {
    console.error("Cron job error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
