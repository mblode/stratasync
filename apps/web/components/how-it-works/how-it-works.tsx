import { siteConfig } from "@/lib/config";

import { EngineProvider } from "./engine";
import { Fig01RoundTrip } from "./figures/fig-01-round-trip";
import { Fig02LocalReplica } from "./figures/fig-02-local-replica";
import { Fig03Diverge } from "./figures/fig-03-diverge";
import { Fig04Log } from "./figures/fig-04-log";
import { Fig05Outbox } from "./figures/fig-05-outbox";
import { Fig06Offline } from "./figures/fig-06-offline";
import { Fig07Rebase } from "./figures/fig-07-rebase";
import { Fig08CatchUp } from "./figures/fig-08-catch-up";
import { Fig09Text } from "./figures/fig-09-text";

const { docs } = siteConfig.links;

/**
 * The article.
 *
 * A Server Component: the prose is static, and only the figures are client
 * islands. One idea per section, demonstrated before the next one starts.
 *
 * The prose carries the argument and the figure carries the mechanism, so
 * anything the figure already shows is not also narrated here.
 */
export const HowItWorks = () => (
  <EngineProvider>
    <p>
      Tick a task off in Linear and it just happens. No spinner, no saving. Do
      it on a plane and it still happens. Every figure below is live, so press
      things.
    </p>

    <h2>1. Why the checkbox waits</h2>
    <p>
      Most apps keep their data on a server and borrow it. You tick a box, the
      app asks the server, and the tick appears when the reply lands. Until then
      the interface is guessing, and the guess is a spinner.
    </p>

    <Fig01RoundTrip />

    <p>You cannot shorten the distance. You can change who waits for it.</p>

    <h2>2. Put the data on the device</h2>
    <p>
      So keep a copy on the device. Not a cache that expires and refetches: a
      real local replica the app reads and writes directly. IndexedDB in a
      browser, SQLite on a phone. Every read answers in microseconds, and the
      network moves to the background.
    </p>

    <Fig02LocalReplica />

    <p>
      That fixes the wait, and creates the problem that fills the rest of this
      page. There is more than one copy now, and copies drift.
    </p>

    <h2>3. Two devices, one truth</h2>
    <p>
      Your laptop and your phone hold the same task. Each writes to its own copy
      first, which is the whole point of the last section. Now they disagree,
      and neither one is wrong.
    </p>

    <Fig03Diverge />

    <p>
      A tie needs a referee: one place that sees every change and puts them in
      an order everyone can agree on.
    </p>

    <h2>4. The server numbers everything</h2>
    <p>
      The referee keeps a list. Every change from every device is appended to
      one log and stamped with the next number in the sequence, a{" "}
      <code>syncId</code>. Devices do not vote on the order. The number decides.
      Each row says what happened to which task, so your device never receives
      tables, only changes, which it replays.
    </p>

    <Fig04Log />

    <p>
      So a device remembers one number: the highest <code>syncId</code> it has
      folded in. Catching up is one question, asked as often as you like. What
      came after this? That only holds if the log never grows a row behind your
      back, so the server holds a lock from insert through commit and the gap
      never opens.
    </p>

    <h2>5. Writing without waiting</h2>
    <p>
      A write hits the local copy first, then joins a queue called the outbox to
      wait its turn on the network. The screen waits for neither.
    </p>

    <Fig05Outbox />

    <p>
      The last step is the one most diagrams get wrong. An acknowledgement does
      not finish a write. The queued entry records the number it is waiting for,
      and retires only when this device’s own cursor passes it. That is what
      makes the local copy agree with the log rather than merely overlap it.
    </p>

    <h2>6. Going offline</h2>
    <p>
      Once every write goes through a queue, offline stops being a mode the app
      handles. The queue is a table on disk sitting next to your tasks, so it
      outlives the tab, the process and the battery. Coming back is not a
      recovery path. It is the same drain, resumed.
    </p>

    <Fig06Offline />

    <p>
      It drains in the order it was written, and every entry carries an id the
      device made up, so a retry is not a second write. The server answers a
      repeat with the number it gave out the first time, which means a device
      can be careless about resending. Worst case is a wasted request.
    </p>

    <h2>7. Rebasing on what you missed</h2>
    <p>
      While your queue waited, the log kept growing. Your device applies what it
      missed, then works out what its own pending changes still mean. That is
      the rebase, and it is the idea git uses: your work is re-authored on top
      of the present rather than merged into the past. Every transaction carries
      a snapshot of the row as it was when you changed it, so the engine can ask
      a narrow question. Did we touch the same field? That beats the useless
      one, which is whose row is newer.
    </p>

    <Fig07Rebase />

    <p>
      Different fields, no collision, both changes survive. Turn{" "}
      <code>fieldLevelConflicts</code> off and those same two writes count as a
      collision, yours is discarded, and your field goes back to where it
      started, because the server never touched it. Off costs you the edit and
      buys you nothing.
    </p>

    <h2>8. Cold start and catching up</h2>
    <p>
      All of that assumes a device that already has the rows. A phone signing in
      for the first time has nothing, and no number. It cannot ask what came
      after, because for it there is no after yet.
    </p>

    <Fig08CatchUp />

    <p>
      So the first answer is unlike every answer after it. The server sends the
      rows as they stand and the number they stand at, and the log is never
      replayed. From then on the phone is on the same footing as every other
      device. A device that falls behind further than the server still keeps is
      told to start over the same way.
    </p>

    <h2>9. Where ordering isn’t enough</h2>
    <p>
      Numbering settles a checkbox. It settles a sentence two people are typing
      into badly. Order those two writes and one of them wins whole, so the
      other person’s words are gone even though the two of you were nowhere near
      each other.
    </p>

    <Fig09Text />

    <p>
      So that text never goes in the log. It goes in a Yjs document, where an
      edit is not “the title is now this” but “put these characters after that
      character”. Two of those compose without a referee. Strata Sync runs both:
      the log for rows, and a Yjs document for any field that needs one, keyed
      by the model, the row and the field name.
    </p>

    <h2>10. The whole loop</h2>
    <p>
      Reads are instant because the data is local. Two local copies drift, so
      the server numbers every change. Writes apply at once and wait in a queue
      instead of holding the screen. The queue is on disk, so offline is not a
      special case, and every entry carries an id the device made up, so a retry
      is not a second write. Coming back means applying what you missed, then
      re-authoring your own changes on top, field by field. A new device pays
      once for everything and after that only for what changed. And the one case
      ordering handles badly is handled by something else.
    </p>
    <p>
      Two things this page left out. A sync group is the permission boundary: it
      decides which rows a device is entitled to, so a phone syncs your
      workspace and not the company’s. A load strategy decides which of those
      arrive at sign-in and which wait until something asks for them. Both are
      in the docs, along with the{" "}
      <a href={`${docs}/architecture/sync-protocol`}>protocol itself</a>, the{" "}
      <a href={`${docs}/guides/conflict-resolution`}>rebase settings</a>, the{" "}
      <a href={`${docs}/guides/load-strategies`}>load strategies</a> and{" "}
      <a href={`${docs}/guides/collaborative-editing`}>collaborative editing</a>
      .
    </p>
  </EngineProvider>
);
