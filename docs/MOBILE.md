# Första körningen från mobilen

Den här guiden tar dig från ett tomt repo till ditt första karusellinlägg på LinkedIn, steg för steg. Den är skriven för
att följas på telefonen. Mer detaljer om varje del finns i [DEPLOY.md](DEPLOY.md).

**Ärligt läge innan du börjar:**

- Inget av detta har körts mot riktiga konton än. Du är den första, och **Check setup** (steg 6) är till för att hitta
  felen innan något publiceras.
- Det första inlägget du godkänner **publiceras på riktigt** på din LinkedIn. Det finns ingen provkörning mot Buffer.
  Godkänn därför bara något du står för.
- Några steg är trista på telefon: GitHub-appen kan inte ändra secrets eller inställningar. Öppna GitHub i
  **webbläsaren** (Safari/Chrome) och välj *Visa datorversion* / *Request desktop site* där guiden säger "i
  webbläsaren". Samma sak gäller Supabase, Cloudflare och Google Cloud.
- Håll ett anteckningsdokument öppet och klistra in alla nycklar där medan du jobbar. Klistra aldrig in en nyckel i en
  chatt eller i repot.

## Vad du behöver (för första karusellen)

| Konto | Till | Kostnad |
|---|---|---|
| GitHub (repot finns redan) | kör maskinen | gratis för publika repon |
| Supabase | databas och inloggning | gratisnivå |
| Cloudflare | granskningsappen | gratis statisk hosting |
| Anthropic | skriver innehållet | per användning, några cent per karusell; sätt en gräns i deras konsol |
| Buffer | publicerar på LinkedIn och mäter | gratisnivå räcker för att börja |

Valfritt senare: Google Drive (egna foton och röstmemon), Gemini (bilder och röstmemon), Higgsfield (video), ntfy
(notiser på telefonen, **rekommenderas**).

---

## Steg 1: Databasen (Supabase)

I webbläsaren på supabase.com:

- [ ] Skapa ett projekt (eller väcka ett pausat). Välj en region nära dig.
- [ ] Kopiera **Session pooler**-anslutningssträngen (Project → *Connect*). Ersätt `[YOUR-PASSWORD]` med
      lösenordet du valde. GitHubs maskiner kan inte nå den direkta adressen (bara IPv6), så det måste vara *pooler*.
- [ ] Kopiera projektets adress (`https://xxxx.supabase.co`) och två nycklar under *Project Settings → API Keys*:
      den **hemliga / service-role-nyckeln** (får aldrig synas i appen) och den **publika (publishable/anon)** nyckeln.
      Menynamnen ändras ibland; leta efter de två nyckeltyperna.

## Steg 2: Lägg in secrets i GitHub

I webbläsaren: repot → *Settings → Secrets and variables → Actions*.

Fliken **Secrets** (*New repository secret*):

- [ ] `DATABASE_URL`: pooler-strängen från steg 1
- [ ] `SUPABASE_URL`: projektadressen
- [ ] `SUPABASE_SERVICE_ROLE_KEY`: den hemliga nyckeln
- [ ] `ANTHROPIC_API_KEY`: från console.anthropic.com → API Keys. Lägg in lite kredit och sätt en månadsgräns.
- [ ] `BUFFER_API_KEY`: från Buffer, *Settings → API* (menyn kan heta något annat; leta efter personlig API-nyckel).
      Det måste vara ett konto där din LinkedIn redan är kopplad som kanal.

## Steg 3: Skapa tabellerna

- [ ] GitHub-appen eller webbläsaren: *Actions → **Apply database migrations** → Run workflow*.
- [ ] Öppna körningen och kontrollera att den blev grön (⚠ röd = läs sista raderna i loggen; felet stod i klartext).

Det går att köra om utan risk. Kör den igen varje gång en uppdatering lägger till en ny migrationsfil.

## Steg 4: Du som granskare

I Supabase (webbläsaren):

- [ ] *Authentication → Users → Add user*: din e-postadress och ett lösenord. Inloggningen släpper bara in
      befintliga användare, så ingen annan kan registrera sig.
- [ ] *SQL Editor* → kör (byt e-postadressen mot din):
  ```sql
  insert into social_admins (user_id) select id from auth.users where email = 'din@epost.se';
  ```
  Utan den raden är granskningskön **tom med flit**.

## Steg 5: Granskningsappen (Cloudflare Pages)

I webbläsaren på dash.cloudflare.com → *Workers & Pages → Create → Pages → Connect to Git*:

- [ ] Välj repot. Bygg-kommando: `npm ci && npm run build:web`. Output-mapp: `web/dist`.
- [ ] Miljövariabler: `VITE_SUPABASE_URL` (projektadressen) och `VITE_SUPABASE_ANON_KEY` (den **publika** nyckeln,
      aldrig service-role).
- [ ] Deploya och kopiera appens adress (`https://något.pages.dev`).
- [ ] I Supabase: *Authentication → URL Configuration* → sätt **Site URL** till appens adress.
- [ ] I GitHub, fliken **Variables**: `APP_URL` = appens adress.
- [ ] Öppna appen på telefonen, logga in, välj *Lägg till på hemskärmen* så blir den en ikon.

## Steg 6: Kanalen (Buffer) och kontrollen

- [ ] *Actions → **List Buffer channels** → Run workflow.* Öppna körningen och leta upp raden som börjar med
      `BUFFER_CHANNELS=`.
- [ ] I GitHub, fliken **Variables**: `BUFFER_CHANNELS` = det som står efter likhetstecknet (till exempel
      `linkedin=abc123`).
- [ ] Fliken **Variables**: `CAROUSEL_HANDLE` = ditt namn på sidorna (till exempel `@david`). Valfritt:
      `CAROUSEL_ACCENT` (till exempel `#4F8CFF`) och `CAROUSEL_THEME` (`dark` eller `light`).
- [ ] Fliken **Variables**: `SOCIAL_ENABLED` = `true`. Tills den är satt gör inga arbetsflöden något.
- [ ] *Actions → **Check setup** → Run workflow.* Det är gratis och skriver aldrig ut en nyckel. Läs varje rad:

| Rad | Så här tolkar du den |
|---|---|
| `ok` | fungerar |
| `warn` | fungerar, men läs notisen |
| `skip` | inte inställt (bra för sådant du inte använder än) |
| `fail` | åtgärda detta innan du går vidare; texten säger vad som saknas |

Typiska fel: `database` = fel anslutningssträng eller migrationerna kördes inte; `reviewer` = steg 4-SQL:en saknas;
`anthropic` = nyckeln avvisades; `buffer` = nyckeln eller kanal-id:t stämmer inte.

## Steg 7: Första karusellen

- [ ] Öppna granskningsappen → **Skapa**.
- [ ] Skriv en idé (till exempel "Tre saker jag önskar att jag visste om marginal i e-handel"), välj format
      **Karusell**, kryssa **LinkedIn**, tryck *Beställ utkast*.
- [ ] Det tar upp till 15 minuter. För att inte vänta: *Actions → **Publish due posts** → Run workflow.*
- [ ] Du får en notis om du har ntfy (steg 9). Annars: öppna appen → **Utkast**. Där ligger bildtexten och sidorna.
- [ ] Läs allt. Fråga dig: stämmer varje påstående? Låter det som du? Ändra bildtexten direkt i appen om något skaver.
      Sidorna kan inte ändras, men du kan avvisa och beställa en ny.
- [ ] Välj tid (förslaget är nästa hela timme; välj några minuter framåt om du vill testa direkt) och tryck
      **Godkänn och schemalägg**.
- [ ] När tiden har passerat: *Actions → **Publish due posts** → Run workflow* (eller vänta på nästa körning, som går
      var 15:e minut). Inlägget publiceras vid första körningen efter den tid du valde.
- [ ] Kolla LinkedIn. Buffer publicerar en stund efter överlämningen; länken fylls i appen när inlägget är uppe, och
      du får besked om Buffer inte kunde publicera.
- [ ] Resultat (visningar, reaktioner) rapporteras av Buffer ungefär en gång per dygn, så vänta till dagen efter.

Går något fel i den här kedjan: *Actions →* den röda körningen → öppna jobbet → läs de sista raderna. Felen skrivs i klartext
och nycklar maskeras.

---

## Valfritt: egna foton och röstmemon från Google Drive

Det här är det jobbigaste på telefon (Google Cloud). Gör det när steg 1 till 7 fungerar.

- [ ] I webbläsaren på console.cloud.google.com: skapa ett projekt, aktivera **Google Drive API**, skapa ett
      **service account** och en nyckel av typen **JSON** (hämtas som fil).
- [ ] Skapa en mapp i Drive (till exempel "Innehållsmotorn") och **dela den** med service-kontots e-postadress
      (`client_email` i JSON-filen), som *Läsare*.
- [ ] Secrets: `GOOGLE_SERVICE_ACCOUNT_JSON` = **hela** innehållet i JSON-filen, `DRIVE_FOLDER_ID` = sista delen av
      mappens adress.
- [ ] *Actions → Check setup* ska nu visa raden `drive` som `ok` och antalet filer.
- [ ] Lägg ett foto (JPEG eller PNG) i mappen och kör *Actions → **Drive sync***. Fotot syns i *Skapa*. Det första
      fotot du väljer blir bakgrund på karusellens omslag.

**Röstmemo** (kräver även `GEMINI_API_KEY` från ett Google AI Studio-projekt **med betalning**, se
[MEMOS.md](MEMOS.md)):

- [ ] Prova först utan inspelning: *Actions → **Memo from text** → klistra in några meningar (diktera med
      tangentbordets mikrofon).* Utkast dyker upp i appen.
- [ ] Spela sedan in ett röstmemo, dela det som **m4a** till Drive-mappen och kör *Actions → **Voice memos***.

## Valfritt: notiser på telefonen (ntfy) och bilder

- [ ] Installera appen **ntfy**, prenumerera på ett långt slumpmässigt ämnesnamn. Secret `NOTIFY_URL` =
      `https://ntfy.sh/ditt-ämnesnamn`. Ämnesnamnet är det enda skyddet, så behandla adressen som en hemlighet.
      *Actions → **Send test notification*** visar om det funkar.
- [ ] Bilder: secret `GEMINI_API_KEY` (billed projekt), sedan *Actions → **Generate image***. Läs loggen första gången: den
      är byggd efter Googles dokumentation men inte körd mot en riktig nyckel.

---

## Det här kostar och det här skyddar dig

- Karusell: Claude-anropet, några cent. Sidorna ritas gratis.
- Röstmemo: ett par öre till några cent.
- Video och bild: per körning, och med ett **månadstak** (`MEDIA_MONTHLY_CAP_USD`, standard 50 USD) som stoppar nya
  jobb.
- **Ingenting publiceras utan ditt godkännande** så länge variabeln `AUTO_APPROVE_CHANNELS` inte är satt. Sätt den inte
  förrän du har läst många utkast och litar på resultatet.

## Om något inte händer

- **Inga schemalagda körningar:** GitHub stänger av schemalagda arbetsflöden i publika repon efter 60 dagar utan
  aktivitet. Starta dem igen under *Actions*. Schemalagda körningar går dessutom bara från standardgrenen, och just nu är
  standardgrenen den grenen arbetet ligger på.
- **Ett inlägg står som "Misslyckad":** öppna det i appen, läs felet. Om det avbröts under publicering: **kolla
  LinkedIn först** (det kan redan ha gått ut) innan du trycker *Försök igen*.
- **Tomt i appen:** nästan alltid steg 4 (granskarraden) eller att du inte är inloggad med rätt användare.
- **"No carousel writer / public storage":** `ANTHROPIC_API_KEY` eller `SUPABASE_*` saknas i arbetsflödets secrets.

## Det här är inte testat live (läs detta)

Buffers API, Drive-synken, Gemini (bild och röst), Supabase Storage-policyn och Higgsfield (särskilt Kling 3.0 och
Seedance) är byggda efter dokumentationen men aldrig anropade med riktiga nycklar. Det första som går fel går troligen fel
där. Det är därför du kör **Check setup** först och börjar med ett enda kort inlägg på en kanal.
