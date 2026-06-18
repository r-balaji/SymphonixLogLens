# Symphonix Log Lens — How It Works (Plain English)

*A guide for anyone on the dev or support team. No coding knowledge needed.*

---

## 1. What problem does this solve?

When something goes wrong in our Salesforce lending app (`loan` package), a
developer turns on **debug logging** and reproduces the issue. Salesforce then
spits out a **debug log** — a giant text file, often 10–20 MB, with tens of
thousands of cryptic lines like:

```
11:33:24.1 (519770696)|METHOD_ENTRY|[307]|01pfh...|loan.LoanRegularPaymentTxnController.doValidate()
11:33:24.1 (835527470)|VARIABLE_ASSIGNMENT|[116]|allowedDate|"2026-04-08T00:00:00.000Z"
```

Reading that by hand is miserable. You can't easily see **which method called
which**, **what values were passed around**, **where the time went**, or **where
it blew up**.

**Log Lens turns that wall of text into a clean, clickable picture** of what the
code actually did — so you can follow the story and find the bug fast.

---

## 2. The big idea in one sentence

> You drop in a Salesforce debug log, and the tool draws the **call tree** (which
> method called which), shows the **values** at each step, marks the
> **managed-package "black boxes"** you can't see inside, and lets you **click
> straight to the source code** line.

---

## 3. Step by step: what you actually do

### Step 1 — Open the tool
Run it locally and open it in your browser. You see a dark (or light) screen that
says **"Drop a Salesforce FINEST debug log."**

### Step 2 — (Optional) Tell it your code
- **Home namespace**: type your package prefix (default `loan`). Everything with
  this prefix is *your* code, shown in full. Everything else (like `clcommon`,
  `mfiflexUtil`) is treated as a **managed-package black box**.
- **Connect repo**: point it at a local copy of your Salesforce code folder. This
  is what lets you click a method and jump to the actual source line.

### Step 3 — Drop the log
Drag the `.log` file onto the page (or click *browse*). In well under a second
the tool reads the whole file and builds the picture.

### Step 4 — Read the story
You now see several connected views:

- **Top bar** — the log's name, who ran it, total time, number of calls. If the
  log captured a crash, a **red exception banner** appears with a "Trace to
  exception" button.
- **Transaction waterfall** (collapsible, click `+`) — horizontal bars, **one per
  class**, sized by how much time was spent in each. The longest bars are your
  performance hotspots. Managed packages show a 🔒 lock.
- **Call tree** (left) — the heart of it. An indented, expandable tree of every
  method call, like a file explorer. Each row shows the class, the method, the
  line number, how long it took (with a little heat bar), and how many values it
  set. Click a triangle to expand/collapse.
- **Inspector** (right) — click any row in the tree and this panel shows its
  details in three tabs:
  - **Values** — the variables that method set and what they were (e.g.
    `allowedDate = "2026-04-08"`). Big record snapshots collapse to
    "{ 60 fields }" and expand on click.
  - **Source** — the actual `.cls` code, opened to the right line (if you
    connected the repo).
  - **Raw log** — the original log lines for that frame, if you want the truth.

### Step 5 — Hunt the bug
A few tools make finding the problem faster:

- **Search box** — type a class, method, or query to filter the tree.
- **Hide** — make noise disappear. Type `clcommon` (or click a preset) and all
  the logging-library clutter vanishes from the flow, lifting its useful children
  up so the chain stays intact.
- **Focus area** — the opposite of hide. Drop in a class name (e.g.
  `LoanTransactionUtil`) and the tree collapses to **only that class's calls**,
  wherever they happen, so you study one thing at a time. Add several. You can
  also click **◎ focus** on any row.
- **Track a value** — click any variable name in the Values panel and you get a
  **timeline** of every place that variable changed across the whole run, with a
  dot marking each change. Perfect for "this number came out wrong — where did it
  go bad?"
- **Multiple logs** — upload several at once. They stack in a left **session
  rail** with status badges (Failed / Slow / OK). Click to switch between them.

### Step 6 — Land on the answer
Following the values and the timing down through the layers, you reach the method
that misbehaves. Click **open source** and you're in the exact `.cls` at the
exact line, looking at the code with the real values that flowed through it.

---

## 4. The "managed package black box" — why it matters

Our app calls into *other* companies' packages (`clcommon`, `mfiflexUtil`).
Salesforce **hides** what happens inside those — the log literally doesn't record
their internal steps. Log Lens is honest about this: it shows them as a distinct
**purple 🔒 "managed package" box** that says "entered X, N statements hidden,"
and shows you the values going *in* and coming *out* at the boundary — which is
all anyone can know. It never pretends to see inside.

---

## 5. What it needs to shine

Some panels (SOQL queries, DML, governor limits, exceptions) only appear when the
log actually recorded them. Our standard logs have those categories turned off,
so those panels stay hidden. To light them all up, capture a log with **`DB` and
`APEX_PROFILING` logging turned on**, and (for the crash view) one that actually
hit an error.

---

## 6. Where everything stays

It all runs **on your own machine**. The log never gets uploaded to the cloud or
any external service. Your source code is read locally too. Nothing leaves your
laptop.

---

## 7. One-paragraph summary

Salesforce debug logs are huge, ugly text files. **Symphonix Log Lens** reads one
in under a second and turns it into a clickable call tree with timing, values, and
source-code links — clearly marking the parts of the run that happen inside
managed packages you can't see into. You hide the noise, focus on the class you
care about, follow a value as it changes, and jump straight to the failing line of
code. It's a magnifying glass for "what did the code actually do, and where did it
go wrong?"
