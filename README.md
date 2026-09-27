# Parat

Packaging recommendations for food commodities. Live demo: https://parat-six.vercel.app

Enter a food and its storage conditions; Parat predicts the oxygen and moisture
barrier it needs and recommends a film structure, thickness, pack format,
shelf life, cost and end of life. It can also issue a QR traceability label.

## Run locally

    ./run.sh          # http://localhost:8000

## Deploy

    vercel deploy --prod

Set `PARAT_SECRET` in the Vercel project so QR labels are signed with your own key.

## Layout

    app/data/          commodities, packaging structures, layer materials, trained model
    app/engine/        physics.py (permeation, respiration), core.py (rules, sizing, scoring), ml.py
    app/train.py       retrains the ranker:  python -m app.train   (needs requirements-dev.txt)
    app/main.py        API
    public/            frontend
    screenshots/       screens captured from the live site

## Limits of this demo

- Barrier values and prices are typical published figures, not supplier datasheets.
- The ranker is trained on simulated cases labelled by the rules engine, because
  no public dataset of packaging decisions exists.
- Shelf life is a prediction and has not been checked against storage trials.
- Labels are verified by signature; they are not stored in a database.
