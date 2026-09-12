import { siteConfig } from "@/lib/config";

import { ListFigure } from "./figures/list";
import { OfflineFigure } from "./figures/offline";
import { ReturnFigure } from "./figures/return";
import { SaveFigure } from "./figures/save";
import { TextFigure } from "./figures/text";
import { UndoFigure } from "./figures/undo";

const { docs } = siteConfig.links;

/**
 * The article.
 *
 * A Server Component: the prose is static, and only the figures are client
 * islands. One idea per section, each shown once, in a figure that runs
 * itself. The prose says why; the figure shows what.
 */
export const HowItWorks = () => (
  <>
    <pre>
      <code>{'task.title = "Hello";\nawait task.save();'}</code>
    </pre>

    <p>
      That is the whole API for changing something. You set a field and call{" "}
      <code>save()</code>. Everything else on this page is what happens next,
      and none of it needs a second line of code from you. Every figure runs on
      its own, so you can just read, or press things.
    </p>

    <h2>The screen updates first</h2>
    <p>
      <code>save()</code> does not send anything yet. It writes the new title
      into a copy of your data that lives on the device, and the screen reads
      from that copy. So the title changes before the network is involved at
      all, and any component showing that task redraws on its own. Then, in the
      background, the change sets off for the server.
    </p>

    <SaveFigure />

    <p>
      The row only ever waits for one thing: to turn from amber to green. That
      is the server saying it has the change too. Until then, the change is real
      on your phone and nowhere else.
    </p>

    <h2>Offline changes nothing</h2>
    <p>
      If there is no network, the change sits in a queue on the device and
      waits. The queue is stored on disk next to your data, so it survives
      closing the app. When the network comes back, the queue sends each change
      in the order you made it.
    </p>

    <OfflineFigure />

    <p>
      Your code does not change for any of this. You call <code>save()</code>{" "}
      the same way whether you are online or not, and the queue takes care of
      the rest.
    </p>

    <h2>The server keeps one list</h2>
    <p>
      Every change from every device goes into one list on the server, and each
      one gets the next number. The server then sends each new entry to every
      other device, which applies it to its own copy. Two devices that have seen
      the same entries hold the same data, with no merging to do.
    </p>

    <ListFigure />

    <p>
      Each device remembers the last number it has seen, so catching up is one
      question: what came after that? A brand-new device has no number yet. It
      asks for everything once, and from then on only asks for what it missed.
    </p>

    <h2>Coming back after a while</h2>
    <p>
      Say your phone was offline for an hour with a change waiting to send, and
      in the meantime someone else changed the same task. When your phone
      reconnects, it first applies what it missed, then puts your own change
      back on top. If the two of you changed different fields, both changes
      stand. If you both changed the same field, theirs was already on the
      server, so yours is dropped rather than overwriting something you never
      saw.
    </p>

    <ReturnFigure />

    <p>
      That decision is made field by field, which is why two people can work on
      the same task all day without treading on each other.
    </p>

    <h2>Undo comes for free</h2>
    <p>
      Every save records what the field was before. So undo is nothing special:
      it saves the old value back, as an ordinary change. It gets a number and
      reaches every other device like any other, which means an undo on your
      laptop shows up on your phone.
    </p>

    <UndoFigure />

    <h2>The one thing a list cannot order</h2>
    <p>
      Numbering settles a title. It does not settle a paragraph two people are
      typing into at the same time: put those two edits in a list and the second
      one replaces the first, words and all. For text like that, Strata Sync
      keeps a Yjs document beside the row, where an edit says where the
      characters go rather than what the whole field is now. Two of those
      combine on their own.
    </p>

    <TextFigure />

    <h2>All of it, from one line</h2>
    <ul>
      <li>The screen updates at once, because the data is on the device.</li>
      <li>Offline changes wait in a queue on disk and send in order.</li>
      <li>
        The server numbers every change, so every device ends up the same.
      </li>
      <li>
        Coming back means applying what you missed and putting your change on
        top, field by field.
      </li>
      <li>Undo saves the old value back, and syncs like anything else.</li>
      <li>Long text merges through Yjs instead of the list.</li>
    </ul>
    <p>
      Two things this page left for the docs. A sync group decides which rows a
      device is allowed to have, so your phone syncs your workspace and not the
      whole company; the{" "}
      <a href={`${docs}/architecture/sync-protocol`}>protocol page</a> covers
      it. A <a href={`${docs}/guides/load-strategies`}>load strategy</a> decides
      which of those rows arrive at sign-in and which wait until something asks
      for them. The{" "}
      <a href={`${docs}/guides/conflict-resolution`}>rebase settings</a> and{" "}
      <a href={`${docs}/guides/collaborative-editing`}>collaborative editing</a>{" "}
      are there too.
    </p>
  </>
);
