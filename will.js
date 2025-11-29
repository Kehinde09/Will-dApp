// -------------------------
// Imports
// -------------------------
import { Lucid, Blockfrost, Data, Constr, fromText } from "https://unpkg.com/lucid-cardano@0.10.11/web/mod.js";

// -------------------------
// Lucid Setup
// -------------------------
const BLOCKFROST_PROJECT_ID = "preprodYjRkHfcazNkL0xxG9C2RdUbUoTrG7wip";

let lucid;
let connectedAddress = null;

async function initLucid() {
  lucid = await Lucid.new(
    new Blockfrost("https://cardano-preprod.blockfrost.io/api/v0", BLOCKFROST_PROJECT_ID),
    "Preprod"
  );
}

// -------------------------
// Will Script Address
// -------------------------
const WILL_ADDRESS = "addr_test1qp25lfg74tj4z0aa68nsn9akqqztqtvvdrc20z4ggaasry827wfqzzv5wnerc3sm4fl9u3wczwq9eakleqacqz7p7t2s0e35zl";

// -------------------------
// DOMContentLoaded
// -------------------------
document.addEventListener("DOMContentLoaded", async () => {
  await initLucid();

  const connectBtn = document.getElementById("connect-btn");
  const copyPubKeyBtn = document.getElementById("copyPubKeyBtn");
  const createWillBtn = document.getElementById("createWillBtn");
  const claimWillBtn = document.getElementById("claimWillBtn");
  const statusDiv = document.getElementById("status");

  // -------------------------
  // Helper
  // -------------------------
  function showStatus(msg, isError = false) {
    if (!statusDiv) return;
    statusDiv.textContent = msg;
    statusDiv.style.color = isError ? "red" : "green";
  }

  // -------------------------
  // Connect Wallet
  // -------------------------
  connectBtn?.addEventListener("click", async () => {
    if (!window.cardano?.lace) {
      alert("⚠️ Lace wallet not found!");
      return;
    }

    try {
      const api = await window.cardano.lace.enable();
      lucid.selectWallet(api);
      connectedAddress = await lucid.wallet.address();
      showStatus(`✅ Connected: ${connectedAddress}`);
      copyPubKeyBtn.disabled = false;
      createWillBtn.disabled = false;
    } catch (err) {
      console.error(err);
      showStatus(`❌ Wallet connection failed: ${err}`, true);
    }
  });

  // -------------------------
  // Copy PubKeyHash
  // -------------------------
  copyPubKeyBtn?.addEventListener("click", async () => {
    if (!connectedAddress) return showStatus("⚠️ Connect wallet first.", true);
    const { paymentCredential } = lucid.utils.getAddressDetails(connectedAddress);
    const pubKeyHash = paymentCredential.hash;
    await navigator.clipboard.writeText(pubKeyHash);
    showStatus(`✅ PubKeyHash copied: ${pubKeyHash}`);
  });

  // -------------------------
  // Create Will (Lock ADA)
  // -------------------------
  createWillBtn?.addEventListener("click", async () => {
    if (!connectedAddress) return showStatus("⚠️ Connect wallet first.", true);

    const beneficiariesInput = document.getElementById("beneficiaries")?.value.trim();
    const unlockInput = document.getElementById("unlockTime")?.value;
    const partialClaimCheckbox = document.getElementById("partialClaim")?.checked;

    if (!beneficiariesInput) return showStatus("⚠️ Enter at least one beneficiary.", true);
    if (!unlockInput) return showStatus("⚠️ Enter unlock time.", true);

    const beneficiaries = beneficiariesInput.split("\n").map(line => line.split(",")[0].trim());
    const amounts = beneficiariesInput.split("\n").map(line => parseFloat(line.split(",")[1].trim()));
    const unlockTime = new Date(unlockInput);
    if (isNaN(unlockTime)) return showStatus("⚠️ Enter a valid unlock time.", true);

    try {
      showStatus("🔄 Preparing transaction...");

      const datum = new Constr(0, [
        Data.to(beneficiaries),
        Data.to(BigInt(unlockTime.getTime())),
        Data.to(partialClaimCheckbox),
        Data.to(amounts.map(a => BigInt(a * 1_000_000))) // convert ADA to lovelace
      ]);

      const userUtxos = await lucid.wallet.getUtxos();

      const tx = await lucid.newTx()
        .collectFrom(userUtxos, Data.void())
        .payToContract(WILL_ADDRESS, { inline: Data.to(datum) }, 
                       { lovelace: amounts.reduce((a,b) => a + b, 0n) })
        .complete({ changeAddress: connectedAddress });

      const signedTx = await tx.sign().complete();
      const txHash = await signedTx.submit();

      showStatus(`✅ Will created! TxHash: ${txHash}`);
    } catch (err) {
      console.error(err);
      showStatus(`❌ Create Will failed: ${err.message || err}`, true);
    }
  });

  // -------------------------
  // Claim Will
  // -------------------------
  claimWillBtn?.addEventListener("click", async () => {
    if (!connectedAddress) return showStatus("⚠️ Connect wallet first.", true);

    const claimBeneficiary = document.getElementById("beneficiaries")?.value.trim();
    const claimAmountInput = document.getElementById("claimAmount")?.value;
    const claimAmount = parseFloat(claimAmountInput);

    if (!claimBeneficiary) return showStatus("⚠️ Enter your PubKeyHash.", true);
    if (!claimAmount || claimAmount <= 0) return showStatus("⚠️ Enter a valid claim amount.", true);

    try {
      showStatus(`🔄 Preparing claim for ${claimAmount} ADA...`);

      const scriptUtxos = await lucid.utxosAt(WILL_ADDRESS);
      if (!scriptUtxos.length) return showStatus("⚠️ No funds available in the Will.", true);

      const utxo = scriptUtxos[0];
      const datum = Data.from(utxo.datum);
      let [beneficiaries, unlockTime, partialAllowed, amounts] = datum;

      if (!partialAllowed) return showStatus("⚠️ Partial claims not allowed.", true);
      if (!beneficiaries.includes(claimBeneficiary)) return showStatus("⚠️ You are not authorized.", true);

      const totalAda = utxo.assets.lovelace || 0n;
      const claimLovelace = BigInt(claimAmount * 1_000_000);
      if (claimLovelace > totalAda) return showStatus("⚠️ Claim amount exceeds locked ADA.", true);
      const remainingAda = totalAda - claimLovelace;

      const redeemer = new Constr(0, []);
      const txBuilder = lucid.newTx().collectFrom([utxo], redeemer)
        .payToAddress(claimBeneficiary, { lovelace: claimLovelace });

      if (remainingAda > 0n) {
        const newDatum = new Constr(0, [
          Data.to(beneficiaries),
          Data.to(unlockTime),
          Data.to(partialAllowed),
          Data.to(amounts)
        ]);
        txBuilder.payToContract(WILL_ADDRESS, { inline: Data.to(newDatum) }, { lovelace: remainingAda });
      }

      const tx = await txBuilder.complete({ changeAddress: connectedAddress });
      const signedTx = await tx.sign().complete();
      const txHash = await signedTx.submit();

      showStatus(`✅ Claim successful! TxHash: ${txHash}`);
    } catch (err) {
      console.error(err);
      showStatus(`❌ Claim failed: ${err.message || err}`, true);
    }
  });

});
