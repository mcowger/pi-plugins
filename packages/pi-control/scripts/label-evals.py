#!/usr/bin/env python3
"""Single-keypress labeler for the pi-controls eval tuning corpus.

Shows each record (most valuable first) and records your verdict with one
keystroke — no Enter needed:

    a = allow    s = ask    d = deny    x = skip (leave unlabeled)
    n = attach a note       b = back to previous item
    ? = help                q = quit (progress is saved after every key)

Usage:
    scripts/label-evals.py [--set train|holdback|all] [--limit N] [--from-id eval-0123]
    scripts/label-evals.py --set train --interpreter bun --limit 30
    scripts/label-evals.py --set train --origin heredoc --limit 30
    scripts/label-evals.py --set train --kind unrecoverable

Corpus paths default to ~/pi-eval-{tuning,train,holdback}.jsonl (kept out of
the repo — session data may contain secrets) and can be overridden:

    scripts/label-evals.py --corpus PATH --train PATH --holdback PATH

Labels are written directly into ~/pi-eval-tuning.jsonl (and the matching
train/holdback file) after every keypress, so quitting anytime is safe.
"""

import argparse
import json
import os
import sys
import termios
import tty

HOME = os.path.expanduser("~")
MASTER = os.path.join(HOME, "pi-eval-tuning.jsonl")
TRAIN = os.path.join(HOME, "pi-eval-train.jsonl")
HOLD = os.path.join(HOME, "pi-eval-holdback.jsonl")

KEYS = {
    "a": "allow",
    "s": "ask",
    "d": "deny",
}

MAX_SOURCE_LINES = 120


def load(path):
    lines = open(path).read().splitlines()
    meta = json.loads(lines[0])
    recs = [json.loads(l) for l in lines[1:]]
    return meta, recs


def save(path, meta, recs):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(json.dumps(meta) + "\n")
        for r in recs:
            f.write(json.dumps(r) + "\n")
    os.replace(tmp, path)


def getch(fd):
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def show(rec, pos, total, done_session, done_total):
    print("\033[2J\033[H", end="")  # clear screen
    print(f"[{pos}/{total}] {rec['id']}  "
          f"labeled {done_total} total ({done_session} this session)")
    print("=" * 70)
    if rec["kind"] == "unrecoverable":
        print(f"UNRECOVERABLE ×{rec['count']} — {rec['detail']}")
        print()
        print("--- command ---")
        print(rec["command"])
    else:
        print(f"{rec['interpreter']} ({rec['language']}, {rec['origin']}) "
              f"×{rec['count']}  cwd: {rec.get('cwd') or '?'}")
        print()
        print("--- command (pipeline context) ---")
        print(rec["command"])
        print()
        print(f"--- source ({rec.get('source_chars', '?')} chars) ---")
        src_lines = (rec["source"] or "").splitlines()
        shown = src_lines[:MAX_SOURCE_LINES]
        print("\n".join(f"{i + 1:4d}  {l}" for i, l in enumerate(shown)))
        if len(src_lines) > MAX_SOURCE_LINES:
            print(f"    … [{len(src_lines) - MAX_SOURCE_LINES} more lines]")
    print()
    if rec.get("expected"):
        print(f"current label: {rec['expected']}"
              + (f"  note: {rec.get('notes')}" if rec.get("notes") else ""))
    print("[a]llow  [s]ask  [d]eny  [x]skip  [n]ote  [b]ack  [?]help  [q]uit")
    print("> ", end="", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", choices=["train", "holdback", "all"], default="all")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--from-id", default=None)
    ap.add_argument("--interpreter", default=None,
                    help="only records with this interpreter (python3, bun, node, …)")
    ap.add_argument("--origin", default=None,
                    help="only records with this origin (inline, heredoc, herestring)")
    ap.add_argument("--kind", choices=["classifiable", "unrecoverable"],
                    default=None, help="only records of this kind")
    ap.add_argument("--corpus", default=MASTER)
    ap.add_argument("--train", default=TRAIN)
    ap.add_argument("--holdback", default=HOLD)
    args = ap.parse_args()

    master_path, train_path, hold_path = args.corpus, args.train, args.holdback

    if not sys.stdin.isatty():
        sys.exit("needs a TTY (run it directly in a terminal)")

    m_meta, master = load(master_path)
    t_meta, train = load(train_path)
    h_meta, hold = load(hold_path)
    by_id = {r["id"]: r for r in train + hold}

    queue = []
    started = args.from_id is None
    for r in master:
        if args.set != "all" and r.get("split") != args.set:
            continue
        if args.interpreter and r.get("interpreter") != args.interpreter:
            continue
        if args.origin and r.get("origin") != args.origin:
            continue
        if args.kind and r.get("kind") != args.kind:
            continue
        if not started:
            if r["id"] == args.from_id:
                started = True
            else:
                continue
        if r.get("expected") is None:
            queue.append(r)
    if args.limit:
        queue = queue[: args.limit]
    if not queue:
        print("Nothing to label (all matching records already have verdicts).")
        return

    total_labeled = sum(1 for r in master if r.get("expected"))
    done_session = 0
    pos = 0
    fd = sys.stdin.fileno()

    def persist():
        save(master_path, m_meta, master)
        save(train_path, t_meta, train)
        save(hold_path, h_meta, hold)

    print(f"{len(queue)} unlabeled records queued. Press ? for help.")
    try:
        while 0 <= pos < len(queue):
            rec = queue[pos]
            show(rec, pos + 1, len(queue), done_session, total_labeled)
            ch = getch(fd).lower()
            print(ch)
            if ch == "q" or ch == "\x03":
                break
            elif ch in KEYS:
                verdict = KEYS[ch]
                if rec.get("expected") != verdict:
                    rec["expected"] = verdict
                    twin = by_id.get(rec["id"])
                    if twin is not None:
                        twin["expected"] = verdict
                    done_session += 1
                    total_labeled = sum(1 for r in master if r.get("expected"))
                    persist()
                pos += 1
            elif ch == "x":
                pos += 1
            elif ch == "b":
                pos = max(0, pos - 1)
            elif ch == "n":
                # getch() already restored cooked mode; plain line input here.
                print("note (Enter to save, empty cancels): ", end="", flush=True)
                note = sys.stdin.readline().strip()
                if note:
                    rec["notes"] = note
                    twin = by_id.get(rec["id"])
                    if twin is not None:
                        twin["notes"] = note
                    persist()
            elif ch == "?":
                print("a/s/d label and advance · x skip · n note · b back · q quit")
                print("press any key…", flush=True)
                getch(fd)
            # any other key: re-show
    except KeyboardInterrupt:
        pass
    finally:
        try:
            persist()
        except Exception as e:
            print(f"\nWARNING: final save failed: {e}")
    print(f"\nDone — {done_session} labeled this session, "
          f"{total_labeled} total. Progress saved.")


if __name__ == "__main__":
    main()
