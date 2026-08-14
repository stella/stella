# Third-party notices

This image contains software and model artifacts published by the
PaddlePaddle project under the Apache License 2.0:

- PaddlePaddle GPU 3.2.2
- PaddleX 3.7.2
- PaddleOCR 3.7.0
- PP-OCRv6 medium text-detection inference model
- PP-OCRv6 medium text-recognition inference model

Upstream source and license texts:

- https://github.com/PaddlePaddle/Paddle
- https://github.com/PaddlePaddle/PaddleX
- https://github.com/PaddlePaddle/PaddleOCR

The model archive URLs and SHA-256 digests are recorded in the Dockerfile.
The archives are distributed from PaddlePaddle's official model host.

The runtime image includes NVIDIA CUDA Toolkit and cuDNN runtime components.
Their license texts and source notices are distributed in the upstream NVIDIA
CUDA image: https://hub.docker.com/r/nvidia/cuda

The locked runtime also contains the following packages whose source
distributions or wheels cause automated scanners to report compound licenses:

- chardet (0BSD): https://github.com/chardet/chardet
- crc32c (LGPL-2.1-or-later): https://github.com/ICRAR/crc32c
- lxml (BSD-3-Clause): https://github.com/lxml/lxml
- protobuf (BSD-3-Clause): https://github.com/protocolbuffers/protobuf
- pyclipper (MIT): https://github.com/fonttools/pyclipper
- pycryptodome (BSD-2-Clause, public-domain components, and Unlicense):
  https://github.com/Legrandin/pycryptodome
- Shapely (BSD-3-Clause): https://github.com/shapely/shapely
- typing-extensions (Python-2.0): https://github.com/python/typing_extensions
- wcwidth (MIT): https://github.com/jquast/wcwidth

Shapely wheels bundle GEOS, which is distributed under LGPL-2.1-or-later:
https://github.com/libgeos/geos
