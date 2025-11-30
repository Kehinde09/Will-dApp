{-# LANGUAGE DataKinds #-}
{-# LANGUAGE NoImplicitPrelude #-}
{-# LANGUAGE TemplateHaskell #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE MultiParamTypeClasses #-}
{-# LANGUAGE TypeApplications #-}
{-# LANGUAGE TypeFamilies #-}
{-# LANGUAGE OverloadedStrings #-}

module Will where

import Prelude (IO, print)
import Plutus.V2.Ledger.Api
import Plutus.V2.Ledger.Contexts
import Plutus.V1.Ledger.Interval (from, contains)
import qualified PlutusTx
import PlutusTx.Prelude
    ( Bool(..), Integer, traceIfFalse,
      (&&), (==), (<=), (>),
      error, any, not )

------------------------------------------------------------
-- DATUM
------------------------------------------------------------

data WillDatum = WillDatum
    { beneficiaries :: [PubKeyHash]
    , unlockTime    :: POSIXTime
    , claimedAmount :: Integer
    }
PlutusTx.unstableMakeIsData ''WillDatum

newtype WillParam = WillParam { owner :: PubKeyHash }
PlutusTx.unstableMakeIsData ''WillParam
PlutusTx.makeLift ''WillParam

------------------------------------------------------------
-- HELPERS
------------------------------------------------------------

{-# INLINABLE anySignedBy #-}
anySignedBy :: TxInfo -> [PubKeyHash] -> Bool
anySignedBy info pkhs = any (txSignedBy info) pkhs

{-# INLINABLE getContinuingDatum #-}
getContinuingDatum :: ScriptContext -> WillDatum
getContinuingDatum ctx =
    case getContinuingOutputs ctx of
        [o] ->
            case txOutDatum o of
                OutputDatum (Datum d) -> PlutusTx.unsafeFromBuiltinData d
                _                     -> error "Expected inline datum"
        _ -> error "Expected exactly one continuing output"

{-# INLINABLE getOwnInputValue #-}
getOwnInputValue :: ScriptContext -> Integer
getOwnInputValue ctx =
    let ins = txInInfoResolved <$> txInfoInputs (scriptContextTxInfo ctx)
     in sum (map (valueOf' . txOutValue) ins)

{-# INLINABLE getOwnOutputValue #-}
getOwnOutputValue :: ScriptContext -> Integer
getOwnOutputValue ctx =
    case getContinuingOutputs ctx of
        [o] -> valueOf' (txOutValue o)
        _ -> error "Expected exactly one continuing output"

{-# INLINABLE valueOf' #-}
valueOf' :: Value -> Integer
valueOf' v = valueOf v "" ""   -- counts ADA

------------------------------------------------------------
-- VALIDATOR
------------------------------------------------------------

{-# INLINABLE mkWillValidator #-}
mkWillValidator :: WillParam -> WillDatum -> () -> ScriptContext -> Bool
mkWillValidator (WillParam ownerPkh) oldDatum _ ctx =
    traceIfFalse "Owner signature missing" signedByOwner &&
    traceIfFalse "Beneficiary signature missing" signedByBeneficiary &&
    traceIfFalse "Too early" timeOK &&
    traceIfFalse "Withdrawal amount invalid" validWithdraw &&
    traceIfFalse "Claim amount mismatch" correctDatumUpdate &&
    traceIfFalse "Overclaiming" notOverclaim
  where
    info = scriptContextTxInfo ctx

    signedByOwner        = txSignedBy info ownerPkh
    signedByBeneficiary  = anySignedBy info (beneficiaries oldDatum)

    timeOK = contains (from $ unlockTime oldDatum) (txInfoValidRange info)

    newDatum = getContinuingDatum ctx

    inputValue  = getOwnInputValue ctx
    outputValue = getOwnOutputValue ctx

    withdrawAmount = inputValue - outputValue

    validWithdraw = withdrawAmount > 0

    correctDatumUpdate =
        claimedAmount newDatum == claimedAmount oldDatum + withdrawAmount

    notOverclaim =
        claimedAmount newDatum <= inputValue     -- cannot inflate

------------------------------------------------------------
-- WRAPPER
------------------------------------------------------------

{-# INLINABLE wrappedValidator #-}
wrappedValidator :: WillParam -> BuiltinData -> BuiltinData -> BuiltinData -> ()
wrappedValidator p d _ c =
    check $ mkWillValidator p datum () ctx
  where
    datum = PlutusTx.unsafeFromBuiltinData d
    ctx   = PlutusTx.unsafeFromBuiltinData c
    check True  = ()
    check False = error ()

validatorCode :: PlutusTx.CompiledCode (WillParam -> BuiltinData -> BuiltinData -> BuiltinData -> ())
validatorCode = $$(PlutusTx.compile [|| wrappedValidator ||])

mkWillInstance :: WillParam -> Validator
mkWillInstance p = mkValidatorScript (validatorCode `PlutusTx.applyCode` PlutusTx.liftCode p)

main :: IO ()
main = print "✅ Partial-claim parameterized will compiled!"
