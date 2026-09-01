import { faq } from "@/lib/config";

/**
 * The questions answer engines get asked about this category, answered in
 * the open rather than behind an accordion so the visible text and the
 * FAQPage node in `lib/config.ts` are the same words.
 */
export const LandingFaq = () => (
  <section className="py-16 md:py-20" id="faq">
    <div className="container-wrapper">
      <div className="mx-auto max-w-3xl space-y-8">
        <h2 className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
          Questions people ask
        </h2>

        <dl className="divide-y divide-border rounded-2xl border border-border bg-card">
          {faq.map((entry) => (
            <div className="px-5 py-5 md:px-6" key={entry.question}>
              <dt className="font-sans text-base font-semibold">
                <h3>{entry.question}</h3>
              </dt>
              <dd className="mt-2 text-muted-foreground text-sm leading-relaxed">
                {entry.answer}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  </section>
);
