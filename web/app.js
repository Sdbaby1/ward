const attackLog = document.querySelector("#attack-log");
const checkLog = document.querySelector("#check-log");
const humanRow = document.querySelector("#human-row");
const receiverInput = document.querySelector("#receiver");
const amountInput = document.querySelector("#amount");

document.querySelector("#attack").addEventListener("click", async () => {
  attackLog.textContent = "Running the injected payment...";
  const response = await fetch("/api/v1/demo/attack", { method: "POST" });
  const body = await response.json();
  attackLog.textContent = body.log || body.error || "No log.";
});

document.querySelectorAll("[data-receiver]").forEach((button) => {
  button.addEventListener("click", () => {
    receiverInput.value = button.getAttribute("data-receiver");
    document.querySelector("#check-form").requestSubmit();
  });
});

document.querySelector("#check-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  humanRow.hidden = true;
  await runCheck(false);
});

document.querySelector("#approve").addEventListener("click", () => runPay(true));
document.querySelector("#reject").addEventListener("click", () => runPay(false));

function yoctoFromNear(value) {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 24) return null;
  return (whole === "0" ? "" : whole) + frac.padEnd(24, "0").replace(/^0+(?=\d)/, "") || "0";
}

async function runCheck() {
  const amountYocto = yoctoFromNear(amountInput.value);
  checkLog.textContent = "Checking...";
  if (amountYocto === null) {
    checkLog.textContent = "Amount must be a NEAR value with at most 24 decimal places.";
    return;
  }
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
  humanRow.hidden = body.decision !== "warn";
}

async function runPay(humanApproved) {
  const amountYocto = yoctoFromNear(amountInput.value);
  if (amountYocto === null) return;
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
  humanRow.hidden = true;
}
