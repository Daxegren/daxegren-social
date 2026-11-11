# Ads-pipeline: Meta → Google Sheets

Hämtar dagsvis data på annonsnivå från Meta Marketing API och skriver den till ett Google Sheet
(flik `meta_daily`). Körs som ett Cloud Run Job och schemaläggs med Cloud Scheduler.
Varje körning hämtar om de senaste 30 dagarna och ersätter dem (Meta justerar nyliga siffror i efterhand);
äldre rader bevaras, så historiken växer.

Kolumner: datum, kampanj/ad set/annons (id + namn), spend, impressions, reach, clicks, link_clicks samt
köp och köpvärde för attributionsfönstren `7d_click` och `1d_view` (separata kolumner så att
attribution kan jämföras konsekvent).

## 1. Meta (görs i webbläsaren)
1. developers.facebook.com → *My Apps* → *Create App* → typ **Business**. Koppla appen till ert Business Manager.
2. business.facebook.com → *Business settings* → *Users* → *System users* → *Add* (roll: Admin eller Employee).
3. *Add assets* → välj annonskontot Gorilla Sports Sweden → behörighet **View performance** räcker.
4. *Generate new token* → välj appen → scope **ads_read** → token utan utgångsdatum. Spara den i lösenordshanteraren.
5. Anteckna annonskonto-ID (Ads Manager → kontoväljaren, siffror efter `act_`).

## 2. Google Cloud (Cloud Shell)
```bash
export PROJECT_ID=<ditt-projekt>
export REGION=europe-north1
gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com sheets.googleapis.com drive.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Service account för jobbet:
```bash
gcloud iam service-accounts create ads-pipeline
export SA=ads-pipeline@$PROJECT_ID.iam.gserviceaccount.com
```

Spara tokenen i Secret Manager (klistra in när det efterfrågas, den hamnar inte i historiken):
```bash
read -s -p "Meta token: " T && printf %s "$T" | gcloud secrets create meta-access-token --data-file=- && unset T
gcloud secrets add-iam-policy-binding meta-access-token \
  --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
```

## 3. Google Sheet
Skapa ett tomt ark, dela det (Redigerare) med service account-adressen `$SA`, och kopiera arkets ID ur URL:en.

## 4. Deploy
Kör från mappen `ads-pipeline`:
```bash
gcloud run jobs deploy meta-to-sheets --source . --region $REGION \
  --service-account $SA \
  --set-secrets META_ACCESS_TOKEN=meta-access-token:latest \
  --set-env-vars META_AD_ACCOUNT_ID=<kontonummer>,SHEET_ID=<arkets-id>,LOOKBACK_DAYS=30
gcloud run jobs execute meta-to-sheets --region $REGION --wait
```
Kontrollera att fliken `meta_daily` fylls.

## 5. Schemalägg (dagligen 06:00 svensk tid)
```bash
gcloud scheduler jobs create http meta-to-sheets-daily \
  --location $REGION --schedule "0 6 * * *" --time-zone Europe/Stockholm \
  --uri "https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/meta-to-sheets:run" \
  --http-method POST --oauth-service-account-email $SA
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:$SA --role=roles/run.invoker
```

## Test lokalt
```bash
pip install -r requirements.txt pytest && pytest tests
```

## Noteringar
- Kostnaden ligger normalt inom Googles gratisnivåer vid denna datamängd.
- Google Ads och TikTok läggs till som egna skript med samma Sheet-upplägg när deras API-åtkomst är godkänd.
