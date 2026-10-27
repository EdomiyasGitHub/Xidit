# Snowball Somali stemmer (generated)

- `somali-stemmer.js` is **generated**: do not edit it by hand. The source
  is `snowball/somali.sbl` in the project root.
- `base-stemmer.js` is the Snowball JavaScript runtime, copied unchanged
  from https://github.com/snowballstem/snowball (`javascript/`), under
  the BSD licence in `LICENSE-snowball.txt`.

To regenerate after editing `somali.sbl` (needs a local build of the
Snowball compiler, which is not part of Xidid):

    git clone https://github.com/snowballstem/snowball && cd snowball && make
    ./snowball ../somali-ir-webapp/snowball/somali.sbl -js \
        -o ../somali-ir-webapp/js/snowball/somali-stemmer
