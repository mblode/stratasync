import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { faq } from "@/lib/config";

/**
 * The questions answer engines get asked about this category. The accordion
 * keeps every answer in the served HTML (see `AccordionContent`), so the
 * visible text and the FAQPage node in `lib/config.ts` stay the same words.
 */
export const LandingFaq = () => (
  <section className="py-16 md:py-20" id="faq">
    <div className="container-wrapper">
      <div className="mx-auto max-w-3xl space-y-8">
        <h2 className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
          Questions people ask
        </h2>

        <Accordion
          className="rounded-2xl border border-border bg-card px-5 md:px-6"
          collapsible
          defaultValue={faq[0].question}
          type="single"
        >
          {faq.map((entry) => (
            <AccordionItem key={entry.question} value={entry.question}>
              <AccordionTrigger className="text-base">
                {entry.question}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground">
                {entry.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  </section>
);
