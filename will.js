// -------------------------
// Imports
// -------------------------
import { Lucid, Blockfrost, Data, Constr } from "https://unpkg.com/lucid-cardano@0.10.11/web/mod.js";

// -------------------------
// Config
// -------------------------
const BLOCKFROST_PROJECT_ID = "preprodYjRkHfcazNkL0xxG9C2RdUbUoTrG7wip";
const NETWORK = "Preprod";
const WILL_ADDRESS = "addr_test1qp25lfg74tj4z0aa68nsn9akqqztqtvvdrc20z4ggaasry827wfqzzv5wnerc3sm4fl9u3wczwq9eakleqacqz7p7t2s0e35zl";

let lucid;
let connectedAddress = null;

// -------------------------
// Initialize Lucid
// -------------------------
async function initLucid() {
    lucid = await Lucid.new(
        new Blockfrost(`https://cardano-preprod.blockfrost.io/api/v0`, BLOCKFROST_PROJECT_ID),
        NETWORK
    );
}

// -------------------------
// Helper: Show status
// -------------------------
function showStatus(msg, isError = false) {
    const statusDiv = document.getElementById("status");
    if (!statusDiv) return;
    statusDiv.textContent = msg;
    statusDiv.style.color = isError ? "red" : "green";
}

// -------------------------
// Connect Wallet
// -------------------------
async function connectWallet() {
    if (!window.cardano?.lace) {
        alert("⚠️ Lace wallet not found!");
        return;
    }
    try {
        const api = await window.cardano.lace.enable();
        lucid.selectWallet(api);
        connectedAddress = await lucid.wallet.address();
        showStatus(`✅ Connected: ${connectedAddress}`);
        document.getElementById("copyPubKeyBtn").disabled = false;
        document.getElementById("createWillBtn").disabled = false;
    } catch (err) {
        console.error(err);
        showStatus(`❌ Wallet connection failed: ${err}`, true);
    }
}

// -------------------------
// Copy PubKeyHash
// -------------------------
function copyPubKeyHash() {
    if (!connectedAddress) return showStatus("⚠️ Connect wallet first.", true);
    const { paymentCredential } = lucid.utils.getAddressDetails(connectedAddress);
    const pubKeyHash = paymentCredential.hash;
    navigator.clipboard.writeText(pubKeyHash);
    showStatus(`✅ PubKeyHash copied: ${pubKeyHash}`);
}

// -------------------------
// Create Will (Lock ADA)
// -------------------------
async function createWill() {
    if (!connectedAddress) return showStatus("⚠️ Connect wallet first.", true);

    const beneficiariesInput = document.getElementById("beneficiaries")?.value.trim();
    const unlockInput = document.getElementById("unlockTime")?.value;
    const partialClaim = document.getElementById("partialClaim")?.checked;

    if (!beneficiariesInput) return showStatus("⚠️ Enter at least one beneficiary.", true);
    if (!unlockInput) return showStatus("⚠️ Enter unlock time.", true);

    try {
        const beneficiaries = [];
        const amounts = [];
        for (const line of beneficiariesInput.split("\n")) {
            const [pubKey, amountStr] = line.split(",").map(s => s.trim());
            if (!pubKey || !amountStr) throw new Error("Invalid beneficiary format");
            beneficiaries.push(pubKey);
            amounts.push(BigInt(parseFloat(amountStr) * 1_000_000));
        }

        const unlockTime = new Date(unlockInput).getTime();
        if (isNaN(unlockTime)) return showStatus("⚠️ Enter a valid unlock time.", true);

        showStatus("🔄 Preparing transaction...");

        const datum = new Constr(0, [
            Data.to(beneficiaries),
            Data.to(BigInt(unlockTime)),
            Data.to(partialClaim),
            Data.to(amounts)
        ]);

        const utxos = await lucid.wallet.getUtxos();
        const totalLovelace = amounts.reduce((a, b) => a + b, 0n);

        const tx = await lucid.newTx()
            .collectFrom(utxos, Data.void())
            .payToContract(WILL_ADDRESS, { inline: Data.to(datum) }, { lovelace: totalLovelace })
            .complete({ changeAddress: connectedAddress });

        const signedTx = await tx.sign().complete();
        const txHash = await signedTx.submit();
        showStatus(`✅ Will created! TxHash: ${txHash}`);
    } catch (err) {
        console.error(err);
        showStatus(`❌ Create Will failed: ${err.message || err}`, true);
    }
}

// -------------------------
// Claim Will
// -------------------------
async function claimWill() {
    if (!connectedAddress) return showStatus("⚠️ Connect wallet first.", true);

    const claimBeneficiary = document.getElementById("beneficiaries")?.value.trim();
    const claimAmount = parseFloat(document.getElementById("claimAmount")?.value);

    if (!claimBeneficiary) return showStatus("⚠️ Enter your PubKeyHash.", true);
    if (!claimAmount || claimAmount <= 0) return showStatus("⚠️ Enter a valid claim amount.", true);

    try {
        showStatus(`🔄 Preparing claim for ${claimAmount} ADA...`);

        const utxos = await lucid.utxosAt(WILL_ADDRESS);
        if (!utxos.length) return showStatus("⚠️ No funds available in the Will.", true);

        const utxo = utxos[0];
        const [beneficiaries, unlockTime, partialAllowed, amounts] = Data.from(utxo.datum);

        if (!partialAllowed) return showStatus("⚠️ Partial claims not allowed.", true);
        if (!beneficiaries.includes(claimBeneficiary)) return showStatus("⚠️ You are not authorized.", true);

        const claimLovelace = BigInt(claimAmount * 1_000_000);
        const totalLovelace = utxo.assets.lovelace || 0n;
        if (claimLovelace > totalLovelace) return showStatus("⚠️ Claim amount exceeds locked ADA.", true);

        const remainingLovelace = totalLovelace - claimLovelace;

        const redeemer = new Constr(0, []);
        const txBuilder = lucid.newTx().collectFrom([utxo], redeemer)
            .payToAddress(claimBeneficiary, { lovelace: claimLovelace });

        if (remainingLovelace > 0n) {
            const newDatum = new Constr(0, [
                Data.to(beneficiaries),
                Data.to(unlockTime),
                Data.to(partialAllowed),
                Data.to(amounts)
            ]);
            txBuilder.payToContract(WILL_ADDRESS, { inline: Data.to(newDatum) }, { lovelace: remainingLovelace });
        }

        const tx = await txBuilder.complete({ changeAddress: connectedAddress });
        const signedTx = await tx.sign().complete();
        const txHash = await signedTx.submit();
        showStatus(`✅ Claim successful! TxHash: ${txHash}`);
    } catch (err) {
        console.error(err);
        showStatus(`❌ Claim failed: ${err.message || err}`, true);
    }
}

// -------------------------
// Event Listeners
// -------------------------
document.addEventListener("DOMContentLoaded", async () => {
    await initLucid();

    document.getElementById("connect-btn")?.addEventListener("click", connectWallet);
    document.getElementById("copyPubKeyBtn")?.addEventListener("click", copyPubKeyHash);
    document.getElementById("createWillBtn")?.addEventListener("click", createWill);
    document.getElementById("claimWillBtn")?.addEventListener("click", claimWill);
});
