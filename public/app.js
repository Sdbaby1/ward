const attackButton = document.querySelector("#attack");
const attackLog = document.querySelector("#attack-log");
const checkLog = document.querySelector("#check-log");
const checkForm = document.querySelector("#check-form");
const humanRow = document.querySelector("#human-row");
const receiverInput = document.querySelector("#receiver");
const amountInput = document.querySelector("#amount");
const amountError = document.querySelector("#amount-error");
const verdict = document.querySelector("#verdict");
const flowNote = document.querySelector("#flow-note");
const submitButton = checkForm.querySelector("button[type='submit']");
const approveButton = document.querySelector("#approve");
const rejectButton = document.querySelector("#reject");
const caseButtons = [...document.querySelectorAll("[data-receiver]")];

const desk = { phase: "ready", subject: null, body: null };

const NOTE = {
  ready: "Next: check a receiver. Block never reaches the signer.",
  invalid: "Next: fix the amount, then check again.",
  checking: "Checking this receiver.",
  paying: "Sending the person's decision. The signer waits.",
  stale: "The receiver or amount changed. Check again. The previous result no longer applies.",
  failed: "The request did not finish. Try again.",
  clear: "Next: the agent may pay. No person is required.",
  awaiting_human: "Next: a person approves or rejects. Nothing is signed until then.",
  signed: "Signed. This payment is finished.",
  rejected: "Not signed. A person rejected the warning.",
  stopped: "Stopped. The signer is not called."
};

const NEXT_NOTE = {
  pay: NOTE.clear,
  ask_human: NOTE.awaiting_human,
  stop: NOTE.stopped,
  retry: "Next: retry the check. The last one failed closed.",
  none: "Next: nothing. This payment is finished."
};

const ICONS = {
  allow:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M8.2 12.2 11 15l4.8-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5 20.5 19H3.5L12 4.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M12 10v4.2M12 16.8h.01" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>',
  block:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M8 8l8 8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>'
};

attackButton.addEventListener("click", async () => {
  attackLog.textContent = "Running the injected payment...";
  setBusy(attackButton, true, "Running...");
  try {
    const response = await fetch("/api/v1/demo/attack", { method: "POST" });
    const body = await response.json();
    attackLog.textContent = body.log || body.error || "No log.";
  } catch {
    attackLog.textContent = "The attack demo did not finish. Run it again.";
  } finally {
    setBusy(attackButton, false);
  }
});

caseButtons.forEach((button) => {
  button.addEventListener("click", () => {
    receiverInput.value = button.getAttribute("data-receiver");
    checkForm.requestSubmit();
  });
});

checkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runCheck();
});

approveButton.addEventListener("click", () => runPay(true));
rejectButton.addEventListener("click", () => runPay(false));
receiverInput.addEventListener("input", syncSubject);
amountInput.addEventListener("input", syncSubject);

markCurrentSection();

function yoctoFromNear(value) {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 24) return null;
  return (whole === "0" ? "" : whole) + frac.padEnd(24, "0").replace(/^0+(?=\d)/, "") || "0";
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
  if (busy) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = label;
    return;
  }
  if (button.dataset.label) button.textContent = button.dataset.label;
}

function setAmountError(message) {
  if (!message) {
    amountError.hidden = true;
    amountError.textContent = "";
    amountInput.removeAttribute("aria-invalid");
    amountInput.setAttribute("aria-describedby", "amount-hint");
    return;
  }
  amountError.hidden = false;
  amountError.textContent = message;
  amountInput.setAttribute("aria-invalid", "true");
  amountInput.setAttribute("aria-describedby", "amount-hint amount-error");
  amountInput.focus();
}

function currentSubject() {
  return { receiver: receiverInput.value, amount: amountInput.value };
}

function sameSubject(subject) {
  return Boolean(subject) && subject.receiver === receiverInput.value && subject.amount === amountInput.value;
}

function phaseFromBody(body) {
  if (!body || typeof body !== "object") return "failed";
  if (
    body.phase === "clear" ||
    body.phase === "awaiting_human" ||
    body.phase === "signed" ||
    body.phase === "rejected" ||
    body.phase === "stopped"
  ) {
    return body.phase;
  }
  const decision = body.decision || body.check?.decision;
  if (body.outcome === "signed" || body.signed === true) return "signed";
  if (body.outcome === "human_rejected") return "rejected";
  if (decision === "warn") return "awaiting_human";
  if (decision === "block" || body.outcome === "stopped") return "stopped";
  if (decision === "allow") return "clear";
  return "failed";
}

function renderDesk() {
  const busy = desk.phase === "checking" || desk.phase === "paying";
  setBusy(submitButton, busy, desk.phase === "paying" ? "Sending..." : "Checking...");
  for (const button of caseButtons) button.disabled = busy;
  const canDecide = desk.phase === "awaiting_human" && !busy;
  approveButton.disabled = !canDecide;
  rejectButton.disabled = !canDecide;
  humanRow.hidden = desk.phase !== "awaiting_human";

  const showsVerdict =
    desk.body &&
    (desk.phase === "clear" ||
      desk.phase === "awaiting_human" ||
      desk.phase === "signed" ||
      desk.phase === "rejected" ||
      desk.phase === "stopped" ||
      desk.phase === "stale");
  if (showsVerdict) {
    renderVerdict(desk.body);
    verdict.dataset.stale = desk.phase === "stale" ? "true" : "false";
  } else if (desk.phase !== "paying") {
    verdict.hidden = true;
    verdict.replaceChildren();
    delete verdict.dataset.stale;
  }

  const next = desk.body && desk.phase !== "stale" && desk.phase !== "failed" ? desk.body.next : null;
  flowNote.textContent = (next && NEXT_NOTE[next]) || NOTE[desk.phase] || NOTE.ready;
}

function syncSubject() {
  if (!desk.subject || !desk.body) return;
  if (desk.phase === "checking" || desk.phase === "paying" || desk.phase === "invalid") return;
  desk.phase = sameSubject(desk.subject) ? phaseFromBody(desk.body) : "stale";
  renderDesk();
}

async function runCheck() {
  const amountYocto = yoctoFromNear(amountInput.value);
  if (amountYocto === null) {
    const message = "Amount must be a NEAR value with at most 24 decimal places.";
    setAmountError(message);
    checkLog.textContent = message;
    desk.phase = "invalid";
    desk.body = null;
    renderDesk();
    return;
  }
  setAmountError("");
  desk.phase = "checking";
  renderDesk();
  checkLog.textContent = "Checking...";
  try {
    const response = await fetch("/api/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "pay-agent.ward.testnet",
        receiverId: receiverInput.value,
        methodName: "pay",
        depositYocto: "0",
        amountYocto
      })
    });
    const body = await response.json();
    checkLog.textContent = JSON.stringify(body, null, 2);
    if (!response.ok) {
      desk.phase = "failed";
      desk.body = body;
      renderDesk();
      return;
    }
    desk.subject = currentSubject();
    desk.body = body;
    desk.phase = phaseFromBody(body);
    renderDesk();
  } catch {
    checkLog.textContent = "The check did not finish. Try again.";
    desk.phase = "failed";
    desk.body = null;
    renderDesk();
  }
}

async function runPay(humanApproved) {
  const amountYocto = yoctoFromNear(amountInput.value);
  if (amountYocto === null || desk.phase !== "awaiting_human" || !sameSubject(desk.subject)) {
    desk.phase = "stale";
    renderDesk();
    return;
  }
  desk.phase = "paying";
  renderDesk();
  checkLog.textContent = humanApproved ? "Asking the signer..." : "Recording the rejection...";
  try {
    const response = await fetch("/api/v1/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        counterparty: receiverInput.value,
        amountYocto,
        humanApproved
      })
    });
    const body = await response.json();
    checkLog.textContent = JSON.stringify(body, null, 2);
    desk.subject = currentSubject();
    desk.body = body;
    desk.phase = response.ok || body.phase ? phaseFromBody(body) : "failed";
    renderDesk();
  } catch {
    checkLog.textContent = "The payment did not finish. Try again.";
    desk.phase = desk.body && sameSubject(desk.subject) ? phaseFromBody(desk.body) : "failed";
    renderDesk();
  }
}

renderDesk();

function renderVerdict(body) {
  const check = body.check && typeof body.check === "object" ? body.check : body;
  const decision = check.decision;
  if (decision !== "allow" && decision !== "warn" && decision !== "block") {
    verdict.hidden = true;
    verdict.replaceChildren();
    return;
  }

  verdict.dataset.decision = decision;
  verdict.replaceChildren();

  const label = document.createElement("p");
  label.className = "verdict-label";
  label.textContent = body.outcome ? "Payment" : "Decision";

  const word = document.createElement("p");
  word.className = `verdict-word ${decision}`;
  word.insertAdjacentHTML("afterbegin", ICONS[decision]);
  const wordText = document.createElement("span");
  wordText.textContent = decision;
  word.append(wordText);

  const meta = document.createElement("p");
  meta.className = "verdict-meta";
  const bits = [];
  if (typeof check.score === "number") bits.push(`Score ${check.score}`);
  if (body.outcome) bits.push(outcomeLine(body));
  meta.textContent = bits.join(" · ");

  verdict.append(label, word, meta);

  const reasons = Array.isArray(check.reasons) ? check.reasons : [];
  if (reasons.length) {
    const list = document.createElement("ul");
    list.className = "reasons";
    for (const reason of reasons) {
      const item = document.createElement("li");
      const code = document.createElement("span");
      code.className = "reason-code";
      code.textContent = String(reason.code || "REASON");
      const detail = document.createElement("span");
      detail.textContent = String(reason.detail || "");
      item.append(code, detail);
      list.append(item);
    }
    verdict.append(list);
  }

  if (check.signals) appendSignals(verdict, check.signals);
  if (typeof body.detail === "string" && body.detail) {
    const detail = document.createElement("p");
    detail.className = "verdict-detail";
    detail.textContent = body.detail;
    verdict.append(detail);
  }
  verdict.hidden = false;
}

function outcomeLine(body) {
  if (body.signed === true) return "Signed";
  if (body.outcome === "human_rejected") return "Not signed · person rejected";
  if (body.signed === false) return "Not signed";
  return String(body.outcome);
}

function appendSignals(parent, signals) {
  const rows = [
    ["Account", signals.exists === false ? "Missing" : "Present"],
    ["Contract", signals.isContract ? "Yes" : "No"],
    ["Transactions", signals.txCount == null ? "Unknown" : String(signals.txCount)],
    ["Prior payments", String(signals.priorAuthorizations ?? 0)],
    ["Reports", String(signals.reportCount ?? 0)],
    ["Confirmed", signals.confirmed ? "Yes" : "No"],
    ["Code changed", signals.codeChangedAtMs ? "Yes" : "No"],
    ["Full-access keys", signals.fullAccessKeys == null ? "Unknown" : String(signals.fullAccessKeys)]
  ];
  const list = document.createElement("ul");
  list.className = "signals";
  for (const [name, value] of rows) {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "signal-name";
    title.textContent = name;
    const reading = document.createElement("span");
    reading.textContent = value;
    item.append(title, reading);
    list.append(item);
  }
  parent.append(list);
}

function markCurrentSection() {
  const links = [...document.querySelectorAll(".nav a")];
  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);
  const update = () => {
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 160) current = section;
    }
    for (const link of links) {
      if (current && link.getAttribute("href") === `#${current.id}`) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
}
