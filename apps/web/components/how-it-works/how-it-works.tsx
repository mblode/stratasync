import { EngineProvider } from "./engine";
import { Fig01RoundTrip } from "./figures/fig-01-round-trip";
import { Fig02LocalReplica } from "./figures/fig-02-local-replica";
import { Fig03Diverge } from "./figures/fig-03-diverge";
import { Fig04Log } from "./figures/fig-04-log";
import { Fig05Outbox } from "./figures/fig-05-outbox";
import { Fig06Offline } from "./figures/fig-06-offline";
import { Fig07Rebase } from "./figures/fig-07-rebase";

/**
 * The article.
 *
 * A Server Component: the prose is static, and only the figures are client
 * islands. Each section introduces exactly one idea, demonstrates it, and ends
 * on the question the next section answers.
 */
export const HowItWorks = () => (
  <EngineProvider>
    <p>
      Tick a checkbox in most apps and it waits. Not for long, and not always,
      but it waits. That wait isn’t the app’s fault. This page builds a sync
      engine up from that one checkbox: local reads, a server-numbered log, an
      offline queue, a rebase step. One idea at a time. Every figure below is
      live, so press things.
    </p>

    <h2>1. Why the checkbox waits</h2>
    <p>
      Most apps keep their data on a server and borrow it. You tick a box, the
      app sends a request, and the tick shows up when the reply lands. In
      between, the interface is guessing. The guess is usually a spinner.
    </p>

    <Fig01RoundTrip />

    <p>
      The distance is real and you can’t do anything about it. What you can
      change is who waits for it. Right now the screen waits, so a slow network
      and a broken app look the same from the sofa.
    </p>

    <h2>2. Put the data on the device</h2>
    <p>
      So keep a copy. Not a cache that expires and refetches: a real local
      replica the app reads and writes directly. IndexedDB in a browser, SQLite
      on a phone. Every query answers out of that copy in microseconds, and the
      network moves to the background.
    </p>

    <Fig02LocalReplica />

    <p>
      That fixes the wait. It also creates the problem that fills the rest of
      this page: once the data lives on the device, there’s more than one copy,
      and copies drift.
    </p>

    <h2>3. Two devices, one truth</h2>
    <p>
      Two people, or one person with a laptop and a phone, hold a copy of the
      same row. Each writes to their own copy first, which is the whole point of
      the last section. Now the two copies say different things. Neither device
      is wrong. Neither one is right either.
    </p>

    <Fig03Diverge />

    <p>
      No amount of cleverness on the devices settles this. Both changes are
      real, both landed at the same moment as far as either device can tell, and
      a tie needs a referee. That’s the next section: one place that sees every
      change and puts them in an order everyone can agree on.
    </p>

    <h2>4. The server numbers everything</h2>
    <p>
      The referee keeps a list. Every change from every device is appended to
      one log, and each one gets stamped with the next number in the sequence: a{" "}
      <code>syncId</code>. Nothing on the devices votes on the order. The number
      decides, and there’s only ever one of them.
    </p>
    <p>
      A row in that log says what happened, to which row, with what data.
      Inserted, updated, deleted, archived, put back. Your device never receives
      rows. It receives these, and replays them. On the wire each one is a
      single letter, so a day of changes is a small download.
    </p>

    <Fig04Log />

    <p>
      So a device only remembers one number: its cursor, the highest{" "}
      <code>syncId</code> it has folded in. Catching up is one question, asked
      as often as you like. What came after this? The answer is a list you apply
      in order.
    </p>
    <p>
      That’s only safe if the log never grows a row behind your back, which is
      harder than it sounds. A sequence hands out ids when a row is inserted.
      The row appears when the transaction commits. Those aren’t the same
      moment. Turn the commit-order lock off in the figure and watch a lower
      number commit a fraction late, behind a reader who already asked for
      everything after a higher one. That row isn’t delayed. For that device
      it’s gone. Strata Sync holds a lock from insert through commit so the gap
      never opens.
    </p>
    <p>
      That’s the read path. It says nothing about the other direction: what your
      device does between you pressing something and the log hearing about it.
    </p>

    <h2>5. Writing without waiting</h2>
    <p>
      A write hits the local copy first, then goes into a queue called the
      outbox to wait its turn on the network. The screen waits for neither. Each
      entry in the queue is a transaction, with a <code>clientTxId</code> the
      device made up and a state that moves as the write travels.
    </p>

    <Fig05Outbox />

    <p>
      The last step is the one most diagrams get wrong. An acknowledgement
      doesn’t finish a write. The queued write records the number it’s waiting
      for, and it retires only when this device’s own cursor passes that number.
      That’s what makes the local copy agree with the log instead of just
      overlapping it.
    </p>

    <h2>6. Going offline</h2>
    <p>
      Once every write goes through a queue, offline stops being a mode the app
      handles. The queue is a table on disk like any other: a{" "}
      <code>_transaction</code> store sitting next to your rows. It outlives the
      tab, the process and the battery. Coming back isn’t a recovery path. It’s
      the same drain, resumed.
    </p>

    <Fig06Offline />

    <p>
      One label is worth reading twice. Both entries say <code>sent</code>, and
      both are still on the laptop. <code>sent</code> means handed to the
      network, not received. The client stamps it before it calls out, so a send
      cut off halfway is never mistaken for one that never left. The label isn’t
      what keeps the write safe. The row underneath it is, and that stays on
      disk until an acknowledgement retires it.
    </p>

    <p>
      The queue drains in the order it was written, with a tiebreak for two
      writes made in the same millisecond. And every entry carries an id the
      device made up, so a retry isn’t a second write. The server keeps a unique
      index on that id and answers a repeat with the number it gave out the
      first time. A device can be careless about resending. Worst case is a
      wasted request.
    </p>

    <p>
      So the queue is safe. It isn’t the only thing that moved while you were
      away.
    </p>

    <h2>7. Rebasing on what you missed</h2>
    <p>
      While your queue waited, the log kept growing. A device coming back holds
      two lists that disagree: the changes it missed, and its own changes that
      haven’t landed. It applies the first, then works out what the second still
      means. That second part is the rebase, and it’s the same idea as rebasing
      a branch in git. Your work gets re-authored on top of the present rather
      than merged into the past.
    </p>
    <p>
      To do that the engine needs one more thing: what the row looked like when
      you made the change. Every transaction carries that snapshot as its{" "}
      <code>original</code>. With the snapshot, your change and the one you
      missed, the engine has three sides of a merge. Now it can ask a narrow
      question. Did we touch the same fields? That beats the useless one, which
      is whose row is newer.
    </p>

    <Fig07Rebase />

    <p>
      Two of those combinations are worth sitting with. The ordinary one:
      different fields, no collision, both changes survive and nobody has to
      choose. Comparing field by field is what buys you that, and it’s on by
      default. Then turn it off. The same two writes now count as a collision,
      the server’s rule discards yours, and the field you changed doesn’t take
      the server’s value, because the server never touched it. It goes back to
      where it started. Turns out switching field-level comparison off loses
      your edit and gains you nothing.
    </p>
    <p>
      The default is <code>server-wins</code>, which sounds harsher than it is.
      It only fires on a real collision on the same field, and it’s the one rule
      that guarantees every device lands on the same row. When your write
      survives, its starting point moves up to the server’s value, so the next
      comparison runs against the row that’s actually there.
    </p>
    <p>
      All of this assumes your device had something to catch up on. A device
      that has never seen the log is a different problem.
    </p>
  </EngineProvider>
);
