// Campus Data with real coordinates
// Campus Data with real coordinates and boundaries
const campusData = {
    iba: {
        name: "Iba Campus",
        center: { lat: 15.318547, lng: 119.98376 },
        zoom: 16,
        boundary: [
            [15.319557427098843, 119.98532279621844],  // Point 1 - Starting point (East side)
            [15.319581842835973, 119.98526771782667],  // Point 2
            [15.319643774836472, 119.98521915685589],  // Point 3
            [15.31971780828745, 119.98516898928784],   // Point 4
            [15.319767402217138, 119.98514511609602],  // Point 5
            [15.319885547520414, 119.98501618965793],  // Point 6
            [15.319899203673842, 119.98499385044124],  // Point 7
            [15.319951885444032, 119.98490989340732],  // Point 8
            [15.320001150019689, 119.98483067534404],  // Point 9
            [15.3201031414007, 119.98467448539415],    // Point 10
            [15.320300021009217, 119.98436592733788],  // Point 11 (Northeast corner)
            [15.320143509927242, 119.98421012726033],  // Point 12
            [15.319993516357215, 119.98406376469012],  // Point 13
            [15.319891613713715, 119.98387404344285],  // Point 14
            [15.319803100064348, 119.98370659533941],  // Point 15
            [15.31957193799758, 119.98326787274604],   // Point 16
            [15.319414921924249, 119.98307625543697],  // Point 17
            [15.319336411646743, 119.98297957932228],  // Point 18
            [15.319330802220644, 119.98293956905079],  // Point 19
            [15.31932169670889, 119.98289340608454],   // Point 20
            [15.319311023652418, 119.98283016872233],  // Point 21
            [15.319406352073202, 119.98219752507367],  // Point 22
            [15.319375457793342, 119.98175711624634],  // Point 23 (Northwest area)
            [15.319375629988386, 119.98175702039657],  // Point 24
            [15.31907771829789, 119.98169313150026],   // Point 25
            [15.318320492398513, 119.98162517449401],  // Point 26
            [15.318050634503166, 119.98177935199033],  // Point 27
            [15.317888189745446, 119.98174229175828],  // Point 28
            [15.317856138349882, 119.98173419920636],  // Point 29
            [15.31779006893953, 119.98171769353934],   // Point 30 (Southwest corner)
            [15.316818355118315, 119.98284506255612],  // Point 31
            [15.31676969491052, 119.98289862478788],   // Point 32
            [15.316722132713025, 119.98295182453586],  // Point 33
            [15.316466765915976, 119.98325457923119],  // Point 34
            [15.31647518298493, 119.98330105137191],   // Point 35
            [15.31649210640515, 119.98331861596108],   // Point 36
            [15.316646938600087, 119.98347111085195],  // Point 37 (South area)
            [15.317942142616204, 119.98474499859955],  // Point 38
            [15.319265545365212, 119.98598825258756],  // Point 39 (Southeast corner)
            [15.319265579992091, 119.98598712688607],  // Point 40
            [15.319360088441343, 119.98578774798978],  // Point 41
            [15.319361441453708, 119.98578590493827],  // Point 42
            [15.31955743217236, 119.98532335566506],   // Point 43
            [15.319557427098843, 119.98532279621844]   // Point 44 - Closing point (same as Point 1)
        ],
        locations: [
            { 
                id: 1,
                name: "Computing and Technology Building",
                shortName: "CCIT",
                labelOffset: [0, 0, 41],
                type: "department", 
                coords: [15.316989, 119.983176],
                description: "BuildA facility that houses computer laboratories, classrooms, and faculty offices for technology-based learning, practical training, and computing-related programs.",
                photo: "images/department/ccit/jpg/1.jpg",
                image: "images/department/ccit/jpg/1.jpg",
                tourPhotos: [
                    {
                        floor: "1st Floor",
                        spots: [
                            { label: "First Floor", src: "images/department/ccit/png/ccit-floor1.png" },
                            { label: "First Floor", src: "images/department/ccit/jpg/ccit-floor2.jpg" },
                            { label: "First Floor", src: "images/department/ccit/jpg/ccit-floor3.jpg" },
                            { label: "First Floor", src: "images/department/ccit/jpg/ccit-floor4.jpg" },
                            { label: "First Floor", src: "images/department/ccit/jpg/ccit-floor5.jpg" },
                            { label: "First Floor", src: "images/department/ccit/jpg/ccit-floor6.jpg" },
                            { label: "First Floor", src: "images/department/ccit/jpg/ccit-floor7.jpg" },
                            { label: "First Floor", src: "images/department/ccit/jpg/ccit-floor8.jpg" },           
                        ]
                    },
                    {
                        floor: "2nd Floor",
                        spots: [
                            { label: "Second Floor", src: "images/department/ccit/jpg/ccit-floor2.1.jpg" },
                            { label: "Second Floor", src: "images/department/ccit/jpg/ccit-floor2.2.jpg" },
                            { label: "Second Floor", src: "images/department/ccit/jpg/ccit-floor2.3.jpg" },
                            { label: "Second Floor", src: "images/department/ccit/jpg/ccit-floor2.4.jpg" },
                            { label: "Second Floor", src: "images/department/ccit/jpg/ccit-floor2.5.jpg" },
                            { label: "Second Floor", src: "images/department/ccit/jpg/ccit-floor2.6.jpg" },
                        ]
                    },
                    {
                        floor: "3rd Floor",
                        spots: [
                            { label: "Third Floor", src: "images/department/ccit/jpg/ccit-floor3.1.jpg" },
                            { label: "Third Floor", src: "images/department/ccit/jpg/ccit-floor3.2.jpg" },
                            { label: "Third Floor", src: "images/department/ccit/jpg/ccit-floor3.3.jpg" },
                            { label: "Third Floor", src: "images/department/ccit/jpg/ccit-floor3.4.jpg" },
                            { label: "Third Floor", src: "images/department/ccit/jpg/ccit-floor3.5.jpg" },
                            { label: "Third Floor", src: "images/department/ccit/jpg/ccit-floor3.6.jpg" },
                        ]
                    }
                ],
                rooms: [                 
                    { id: 101, name: "SBO Office", coords: [15.31758, 119.98223 ], floor: "Ground Floor", iconOffset: [0, 0] },  
                    { id: 102, name: "CCIT Room 5", coords: [15.31754, 119.98227], floor: "Ground Floor", iconOffset: [0, 0], instructor: "Mr. Joseph J. Juliano" },
                    { id: 103, name: "CCIT Room 4", coords: [15.31751, 119.98231], floor: "Ground Floor", iconOffset: [0, 0], instructor: "Mr. Daniel A. Bachillar"},
                    { id: 104, name: "CCIT Room 3", coords: [15.31747, 119.98235], floor: "Ground Floor", iconOffset: [0, 0], instructor: "Mr. Hansel S. Ada" },
                    { id: 105, name: "CCIT Room 2", coords: [15.31744, 119.98239], floor: "Ground Floor", iconOffset: [0, 0], instructor: "Engr. Melojean C. Marave" },       
                    { id: 106, name: "CCIT Room 1", coords: [15.31740, 119.98243], floor: "Ground Floor", iconOffset: [0, 0], instructor: "Mr. Israel M. Cabasug" },

                    { id: 107, name: "CCIT Room 11", coords: [15.31758, 119.98221], floor: "2nd Floor", iconOffset: [-5, 15], instructor: "Mr. Jason S. Artates" },
                    { id: 108, name: "CCIT Room 10", coords: [15.31754, 119.98225], floor: "2nd Floor", iconOffset: [-5, 15], instructor: "Mr. Darwin Moraña" },
                    { id: 109, name: "CCIT Room 9", coords: [15.31751, 119.98229], floor: "2nd Floor", iconOffset: [-5, 16], instructor: "Mr. Jiel M. Dullas Jr." },
                    { id: 110, name: "CCIT Room 8", coords: [15.31747, 119.98233], floor: "2nd Floor", iconOffset: [-5, 16], instructor: "Mr. Daryll John C. Ragadio" },   
                    { id: 111, name: "CCIT Room 7", coords: [15.31744, 119.98237], floor: "2nd Floor", iconOffset: [-5, 17], instructor: "Dr. Geoffrey S. Sepillo" },
                    { id: 112, name: "CCIT Room 6", coords: [15.31740, 119.98240], floor: "2nd Floor", iconOffset: [-4, 14], instructor: "Engr. Carl Angelo S. Pamplona"},

                    { id: 113, name: "Storage Room", coords: [15.31688, 119.98322], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 114, name: "Faculty Office", coords: [15.31690, 119.98320], floor: "Ground Floor", iconOffset:[-1, 0] },
                    { id: 115, name: "Programs Chair’s Office", coords:[15.31692, 119.98318], floor: "Ground Floor", iconOffset: [-1, 2] },
                    { id: 116, name: "Multi Media Center", coords: [15.31694, 119.98316], floor: "Ground Floor", iconOffset:[-1, 2] }, 
                    { id: 117, name: "Dean’s Office", coords: [15.31696, 119.98314], floor: "Ground Floor", iconOffset: [-3, 1] },
                    { id: 118, name: "Storage Room", coords: [15.31698, 119.98312], floor: "Ground Floor", iconOffset: [-5, 0] },
                    { id: 119, name: "Comfort Room (F/M)", coords:[15.31700, 119.98310], floor:"Ground Floor" , iconOffset:[-7, 0]},
                    { id: 120, name: "Programs Chair’s Office", coords: [15.31702, 119.98308], floor: "Ground Floor", iconOffset: [-9, -1] },

                    { id: 201, name: "Hybrid Laboratory 1", coords: [15.31695, 119.98330], floor: "2nd Floor", iconOffset: [-14, 14] },
                    { id: 202, name: "Computer Laboratory 1", coords: [15.31697, 119.98328], floor: "2nd Floor", iconOffset: [-20, 10] },
                    { id: 203, name: "Hybrid Laboratory 2", coords: [15.31699, 119.98326], floor: "2nd Floor", iconOffset: [-26, 6] },
                    { id: 204, name: "Laboratory Custodian Office", coords: [15.31701, 119.98324], floor: "2nd Floor", iconOffset: [-32, 2] },
                    { id: 205, name: "Comfort Room (F/M)", coords: [15.31703, 119.98322], floor: "2nd Floor", iconOffset: [-38, -2] },
                    { id: 206, name:"Faculty", coords:[15.31705, 119.98320], floor:"2nd Floor", iconOffset:[-44,-6]},

                    { id: 301, name: "Hybrid Laboratory 3", coords: [15.31695, 119.98330], floor: "3rd Floor", iconOffset: [0, 0] },
                    { id: 302, name: "Computer Laboratory 3", coords: [15.31697, 119.98328], floor: "3rd Floor", iconOffset: [-6, -4] },
                    { id: 303, name: "Computer Laboratory 2", coords: [15.31699, 119.98326], floor: "3rd Floor", iconOffset: [-12, -8] },
                    { id: 304, name: "Extension Office", coords: [15.31701, 119.98324], floor: "3rd Floor", iconOffset: [-18, -12] },
                    { id: 305, name: "Comfort Room (F/M)", coords: [15.31703, 119.98322], floor: "3rd Floor", iconOffset: [-24, -16] },
                    { id: 306, name:"Faculty", coords:[15.31705, 119.98320], floor:"3rd Floor", iconOffset:[-30,-20]},
                ]
            },
            {
                id: 2,
                name: "College of Nursing Building",
                shortName: "CON",
                labelOffset: [0, 0, 41],
                type: "department",
                coords: [15.317352, 119.982491],
                description: "A facility that houses classrooms, nursing laboratories, simulation rooms, and faculty offices to support nursing education, clinical skills training, and healthcare-related learning.",
                photo: "images/department/nursing/jpg/5.jpg",
                image: "images/department/nursing/jpg/5.jpg",
                rooms: [
                    { id: 201, name: "Lecture Room 6", coords: [15.31735, 119.98249], floor: "2nd Floor", iconOffset: [-17, 15] },
                    { id: 202, name: "Lecture Room 5", coords: [15.31730, 119.98254], floor: "2nd Floor", iconOffset: [-15, 15] },
                    { id: 203, name: "Lecture Room 4", coords: [15.31725, 119.98259], floor: "2nd Floor", iconOffset: [-13, 15] },
                    { id: 204, name: "Lecture Room 3", coords: [15.31720, 119.98264], floor: "2nd Floor", iconOffset: [-11, 15] },
                    { id: 205, name: "Lecture Room 2", coords: [15.31715, 119.98269], floor: "2nd Floor", iconOffset: [-9, 16] },
                    { id: 206, name: "Lecture Room 1", coords: [15.31710, 119.98274], floor: "2nd Floor", iconOffset:[-7, 16]},
                    { id: 207, name: "CSBO Office", coords: [15.31705, 119.98279], floor: "2nd Floor", iconOffset: [-5, 15] },

                    { id: 101, name: "Dean’s Office/Faculty Room", coords: [15.31705, 119.98277], floor: "Ground Floor", iconOffset: [16, 1] },
                    { id: 102, name: "Science Laboratory", coords: [15.31710, 119.98272], floor: "Ground Floor", iconOffset: [13, 0] },
                    { id: 103, name: "Old Skill Laboratory", coords: [15.31715, 119.98267], floor: "Ground Floor", iconOffset: [10, -1] },
                    { id: 104, name: "Accreditation Room", coords: [15.31720, 119.98262], floor: "Ground Floor",    iconOffset: [7, -2] },
                ]
            },
            {
                id: 3,
                name: "College of Engineering Building",             
                shortName: "COE",
                labelOffset: [0, 0, 41],
                type: "department",
                coords: [15.317704, 119.982067],
                description:"Develops skilled engineers equipped for innovation, problem-solving, and technological advancement.",
                photo: "images/department/coe/jpg/7.jpg",
                image: "images/department/coe/jpg/7.jpg",
                rooms: [
                    { id: 101, name: "COE 103 CMR&SOIL Mechanics Laboratory", coords: [15.31766, 119.98213], floor: "Ground Floor", iconOffset: [10, 10] },
                    { id: 102, name: "COE 102 Hydraulics Laboratory", coords: [15.31771, 119.98208], floor: "Ground Floor", iconOffset: [13, 15] },
                    { id: 103, name: "Civil Engineering Department Faculty Room", coords: [15.31776, 119.98203], floor: "Ground Floor", iconOffset: [17, 20] },
                    { id: 104, name: "Comfort Room (F/M)", coords: [15.31781, 119.98198], floor: "Ground Floor", iconOffset: [22, 25] },
                    { id: 105, name: "Storage Room", coords: [15.31786, 119.98193], floor: "1st Floor", iconOffset: [26, 30] },
                    
                    { id: 201, name: "COE Computer Laboratory", coords: [15.31763, 119.98214], floor: "2nd Floor", iconOffset: [-70, -50] },
                    { id: 202, name: "COE 201 Classroom", coords: [15.31768, 119.98209], floor: "2nd Floor", iconOffset: [-30, -10] },
                    { id: 203, name: "COE 202 Classroom", coords: [15.31773, 119.98204], floor: "2nd Floor", iconOffset: [10, 30] },
                    { id: 204, name: "COE 203 Classroom", coords: [15.31778, 119.98199], floor: "2nd Floor", iconOffset: [50, 70] },
                ]
            },
            {
                id: 4,
                name: "College of Physical Education",
                shortName: "CPE",
                labelOffset: [0, 0, 0],
                type: "department",
                coords: [15.317968, 119.982376],
                description: "Develops skilled professionals in sports, fitness, and health education.",
                photo: "images/department/cpe/jpg/6.jpg",
                image: "images/department/cpe/jpg/6.jpg",
                rooms: [
                    {id: 101, name: "Faculty Room P.E Department", coords: [15.31841, 119.98239], floor: "1st Floor", iconOffset: [-5, 0] },
                    {id: 102, name: "BPED 1B", coords: [15.31802, 119.98239], floor: "1st Floor", iconOffset: [-5, 0] },
                    {id: 103, name: "BPED", coords: [15.31795, 119.98239], floor: "1st Floor", iconOffset: [-5, 0] },
                    {id: 104, name: "BPED", coords: [15.31795, 119.98239], floor: "1st Floor", iconOffset: [-75, 0] },
                    {id: 105, name: "BPED", coords: [15.31802, 119.98239], floor: "1st Floor", iconOffset: [-75, 0] },
                    {id: 106, name: "Comfort Room (F/M)", coords: [15.31795, 119.98239], floor: "1st Floor", iconOffset: [-40, 0] },

                    {id: 201, name: "NSTP Office", coords: [15.31836, 119.98239], floor: "2nd Floor", iconOffset: [-5, 0] },
                    {id: 202, name: "Crim P.E Area", coords: [15.31836, 119.98232], floor: "2nd Floor", iconOffset: [-5, 0] },
                    {id: 203, name: "CRIM Scene Room Station 3", coords: [15.31836, 119.98225], floor: "2nd Floor", iconOffset: [-5, 0] },
                    {id: 204, name: "Comfort Room (F/M)", coords: [15.31836, 119.98218], floor: "2nd Floor", iconOffset: [-5, 0] },
                ]
            },
            {
                id: 5,
                name: "Gymnasium",
                shortName: "GYMNASIUM",
                labelOffset: [0, 0, 0],
                type: "facilities",
                coords: [15.318362, 119.982282],
                description: "Indoor basketball court, fitness center, and sports facilities",
                photo: "images/facilities/gymnasium/jpg/9.jpg",
                image: "images/facilities/gymnasium/jpg/9.jpg",
                rooms: []
            },
            {
                id: 6,
                name: "Science and Engineering Laboratory Building",               
                shortName: "SELB",
                labelOffset: [0, 0, -86],
                type: "department",
                coords: [15.318729, 119.981888],
                description: "Supports research, experiments, and practical learning in science and engineering disciplines.",
                photo: "images/department/selb/jpg/8.jpg",
                image: "images/department/selb/jpg/8.jpg",  
                rooms: [
                    { id: 100, name: "SELB 100 Dean’s Office", coords: [15.31832, 119.98186], floor: "Ground Floor", iconOffset: [5, 0] },
                    { id: 101, name: "SELB 101 Mechanical Engineering Department", coords: [15.31839, 119.98186], floor: "Ground Floor", iconOffset: [6, 0] },
                    { id: 102, name: "SELB 102 Audio Visual Room", coords: [15.31846, 119.98186], floor: "Ground Floor", iconOffset: [7, 0] },
                    { id: 103, name: "SELB 103 Mechanical Engineering Laboratory Room 1", coords: [15.31853, 119.98186], floor: "Ground Floor", iconOffset: [8, 0] },
                    { id: 104, name: "SELB 104 Mechanical Engineering Laboratory Room 2", coords: [15.31860, 119.98186], floor: "Ground Floor", iconOffset: [9, 0] },
                    { id: 105, name: "Comfort Room", coords: [15.31867, 119.98186], floor: "Ground Floor", iconOffset: [10, 0] },
                    
                    { id: 205, name: "SELB 205 Electrical Engineering Department", coords: [15.31832, 119.98184], floor: "2nd Floor", iconOffset: [0, -1] },
                    { id: 204, name: "SELB 204 Physical Lab", coords: [15.31839, 119.98184], floor: "2nd Floor", iconOffset: [1, -1] },
                    { id: 203, name: "SELB 203 EE and ECE Laboratory Room", coords: [15.31846, 119.98184], floor: "2nd Floor", iconOffset: [2, -1] },
                    { id: 202, name: "SELB 202 Electrical Engineering Laboratory Room 2", coords: [15.31853, 119.98184], floor: "2nd Floor", iconOffset: [3, -1] },
                    { id: 201, name: "SELB 201 Electrical Engineering Laboratory Room 1", coords: [15.31860, 119.98184], floor: "2nd Floor", iconOffset: [4, -1] },
                    { id: 206, name: "Comfort Room", coords: [15.31867, 119.98184], floor: "2nd Floor", iconOffset: [5, -1] },
                    
                    { id: 301, name: "SELB 301 Computer Engineering Department", coords: [15.31832, 119.98182], floor: "3rd Floor", iconOffset: [-5, -2] },
                    { id: 302, name: "SELB 302A Software Engineering Laboratory Room", coords: [15.31839, 119.98182], floor: "3rd Floor", iconOffset: [-4, -2] },
                    { id: 303, name: "SELB 303B Networking Laboratory Room", coords: [15.31846, 119.98182], floor: "3rd Floor", iconOffset: [-3, -2] },
                    { id: 304, name: "SELB 304 Chemistry Laboratory Room", coords: [15.31853, 119.98182], floor: "3rd Floor", iconOffset: [-2, -2] },
                    { id: 305, name: "SELB 305 Digital Electronics Laboratory Room", coords: [15.31860, 119.98182], floor: "3rd Floor", iconOffset: [-1, -2]},
                    { id: 306, name: "Comfort Room", coords: [15.31867, 119.98182], floor: "3rd Floor", iconOffset: [0, -2] }
                ]
            },
            {
                id: 7,  
                name: "College of Business, Accountancy, and Public Administration Building",
                shortName: "CBAPA",
                labelOffset: [0, 0, 11],
                type: "department",
                coords: [15.319194, 119.982286],
                description: "A facility that houses classrooms, faculty offices, and learning spaces for business, accountancy, and public administration programs.",
                photo: "images/department/cbapa/jpg/10.jpg",
                image: "images/department/cbapa/jpg/10.jpg",
                rooms: [
                    { id: 101, name: "Comfort Room", coords: [15.31919, 119.98216], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 102, name: "CBAPA Faculty", coords: [15.31918, 119.98222], floor: "Ground Floor", iconOffset: [0, 2] },
                    { id: 103, name: "CBAPA Room 101", coords: [15.31917, 119.98228], floor: "Ground Floor", iconOffset: [0, 2] },
                    { id: 104, name: "CBAPA ROOM 102", coords: [15.31916, 119.98234], floor: "Ground Floor", iconOffset: [0, 3] },
                    { id: 105, name: "Research Office", coords: [15.31915, 119.98240], floor: "Ground Floor", iconOffset: [0, 4] },

                    { id: 201, name: "Supply Room", coords: [15.31921, 119.98216], floor: "2nd Floor", iconOffset: [2, -8] },
                    { id: 202, name: "CBAPA Room 203", coords: [15.31920, 119.98222], floor: "2nd Floor", iconOffset: [2, -7] },
                    { id: 203, name: "CBAPA Room 202", coords: [15.31919, 119.98228], floor: "2nd Floor", iconOffset: [2, -6] },
                    { id: 204, name: "CBAPA ROOM 201", coords: [15.31918, 119.98234], floor: "2nd Floor", iconOffset: [2, -4] },
                    { id: 205, name: "Accreditation Room", coords: [15.31917, 119.98240], floor: "2nd Floor", iconOffset: [2, -4] },
                    { id: 301, name: "Comfort Room", coords: [15.31923, 119.98216], floor: "3rd Floor", iconOffset: [4, -15] },
                    { id: 302, name: "CBAPA AVR", coords: [15.31922, 119.98222], floor: "3rd Floor", iconOffset: [4, -14] },
                    { id: 303, name: "CBAPA Room 301", coords: [15.31921, 119.98228], floor: "3rd Floor", iconOffset: [4, -13] },
                    { id: 304, name: "CBAPA ROOM 302", coords: [15.31920, 119.98234], floor: "3rd Floor", iconOffset: [4, -12] },
                    { id: 305, name: "Extension Service Office", coords: [15.31919, 119.98240], floor: "3rd Floor", iconOffset: [4, -11] },
                ]
            },
            {
                id: 8,
                name: "College of Law Building",
                shortName: "LAW",
                labelOffset: [0, 0, 12],
                type: "department",
                coords: [15.319075, 119.982991],
                description: "A facility that houses classrooms, faculty offices, and learning spaces for legal education, research, and law-related academic activities.",
                photo: "images/department/law/jpg/12.jpg",
                image: "images/department/law/jpg/12.jpg",
                rooms: []
            },
            {
                id: 9,
                name: "Administration Building",
                shortName: "ADMIN BLDG.",
                labelOffset: [0, 0, 36],
                type: "administration",
                coords: [15.318348, 119.983544],
                description: "Main administrative building of PRMSU housing key offices and academic departments",
                photo: "images/administration/admin-building/jpg/15.jpg",
                image: "images/administration/admin-building/jpg/15.jpg",
                rooms: [
                    { id: 101, name: "Collecting and Disbursing Office", coords: [15.31848, 119.98348], floor: "Ground Floor", iconOffset: [-5, -10] },
                    { id: 102, name: "Office of the Resident Auditor", coords: [15.31844, 119.98354], floor: "Ground Floor", iconOffset: [-14, -15] },
                    { id: 103, name: "Cashier", coords: [15.31840, 119.98360], floor: "Ground Floor", iconOffset: [-22, -20] },
                    { id: 104, name: "Budgeting Services Office", coords: [15.31836, 119.98366], floor: "Ground Floor", iconOffset: [-31, -24] },
                    { id: 105, name: "Human Resources Management Office", coords: [15.31832, 119.98372], floor: "Ground Floor", iconOffset: [-39, -29] },
                    { id: 106, name: "Accounting Services Office", coords: [15.31828, 119.98378], floor: "Ground Floor", iconOffset: [-47, -33] },
                    { id: 107, name: "Chief Administrative Officer Director, Admin Services", coords: [15.31824, 119.98384], floor: "Ground Floor", iconOffset: [-55, -39] },
                    { id: 108, name: "Comfort Room", coords: [15.31820, 119.98390], floor: "Ground Floor", iconOffset: [-63, -43] },

                    { id: 201, name: "Procurement Management Office", coords: [15.31842, 119.98340], floor: "2nd Floor", iconOffset: [14, -19] },
                    { id: 202, name: "Office of the Vice President for Planning and Quality Management", coords: [15.31839, 119.98344], floor: "2nd Floor", iconOffset: [12, -21] },
                    { id: 203, name: "Office of the Vice President for Academic Affairs", coords: [15.31836, 119.98348], floor: "2nd Floor", iconOffset: [11, -21] },
                    { id: 204, name: "Office of the Vice President for Research and Development", coords: [15.31833, 119.98352], floor: "2nd Floor", iconOffset: [11, -22] },
                    { id: 205, name: "Office of the University President", coords: [15.31830, 119.98356], floor: "2nd Floor", iconOffset: [10, -22] },
                    { id: 206, name: "Office of the Vice President for Administration and Finance", coords: [15.31827, 119.98360], floor: "2nd Floor", iconOffset: [9, -22] },
                    { id: 207, name: "Office of the University and Board Secretary", coords: [15.31824, 119.98364], floor: "2nd Floor", iconOffset: [8, -23] },
                    { id: 208, name: "Interview Room", coords: [15.31821, 119.98368], floor: "2nd Floor", iconOffset: [7, -23] },

                    { id: 301, name: "Information & Communications Technology Office", coords: [15.31835, 119.98334], floor: "3rd Floor", iconOffset: [25, -31] },
                    { id: 302, name: "Internal Audit Services Office", coords: [15.31832, 119.98338], floor: "3rd Floor", iconOffset: [24, -33] },
                    { id: 303, name: "Futures Thinking Innovation Workspace", coords: [15.31829, 119.98342], floor: "3rd Floor", iconOffset: [23, -33] },
                    { id: 304, name: "Statistical Services Intellectual Property Service Office", coords: [15.31826, 119.98346], floor: "3rd Floor", iconOffset: [22, -34] },
                    { id: 305, name: "Office of the University and Board Secretary (Records Room)", coords: [15.31823, 119.98350], floor: "3rd Floor", iconOffset: [21, -34] },
                    { id: 306, name: "Research and Development, Extension and Production Services Office", coords: [15.31820, 119.98354], floor: "3rd Floor", iconOffset: [20, -34] },
                    { id: 307, name: "Project Development Office", coords: [15.31817, 119.98358], floor: "3rd Floor", iconOffset: [19, -35] },

                    { id: 401, name: "Records Management Services Office", coords: [15.31835, 119.98334], floor: "4th Floor", iconOffset: [14, -16] },
                ]
            },
            {
                id: 10,
                name: "President Ramon Magsaysay Statue PRMSU",
                shortName: "STATUE",
                labelOffset: [0, 0, 36],
                type: "landmark",
                coords: [15.318538, 119.983757],
                description: "A commemorative statue honoring President Ramon Magsaysay, symbolizing leadership and integrity at PRMSU.",
                photo: "images/landmark/statue/jpg/16.jpg",
                image: "images/landmark/statue/jpg/16.jpg", 
            },
            {
                id: 11,
                name: "Registrar Building",
                shortName: "REGISTRAR",
                labelOffset: [0, 0, -55],
                type: "administration",
                coords: [15.318755, 119.984371],
                description: "Building dedicated to student records, enrollment, and academic documentation services.",
                photo: "images/administration/registrar-building/jpg/30.jpg",
                image: "images/administration/registrar-building/jpg/30.jpg", 
                rooms: ["Registrar’s Office", "Records Section", "Evaluation Room", "Releasing Section", "Waiting Area"]
            },
            {
                id: 12,
                name: "E-Library",
                shortName: "LIBRARY",
                labelOffset: [0, 0, -52],
                type: "facilities",
                coords: [15.318796, 119.984987],
                description: "Digital library providing online resources, study spaces, and computer access for students and faculty.",
                photo: "images/facilities/e-library/jpg/27.jpg",
                image: "images/facilities/e-library/jpg/27.jpg", 
                rooms: ["Computer Section", "Reading Area", "Discussion Room", "Faculty Resource Area", "Printing and Scanning Section"]
            },
            {
                id: 13,
                name: "College of Tourism and Hospitality Management",
                shortName: "CTHM",
                labelOffset: [0, 0, 35],
                type: "department",
                coords: [15.319661, 119.984356],
                description: "Academic building for Tourism and Hospitality programs, featuring training laboratories and classrooms..",
                photo: "images/department/cthm/jpg/20.jpg",
                image: "images/department/cthm/jpg/20.jpg", 
                rooms: [
                    { id: 101, name: "Dean’s Office", coords: [15.31960, 119.98450], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 102, name: "CTHM Room 107 & CTHM AVR Room", coords: [15.31966, 119.98441], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 103, name: "CTHM Room 109", coords: [15.31972, 119.98432], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 104, name: "CTHM Room 110", coords: [15.31978, 119.98423], floor: "Ground Floor", iconOffset: [0, 0] },

                    { id: 105, name: "Office of the Campus Director", coords: [15.31953, 119.98459], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 106, name: "CTHM DID Room", coords: [15.31948, 119.98466], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 107, name: "CTHM Room 102", coords: [15.31943, 119.98473], floor: "Ground Floor", iconOffset: [0, 0]},
                    { id: 108, name: "CTHM Room 103", coords: [15.31938, 119.98480], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 109, name: "CBAPA Faculty Room", coords: [15.31933, 119.98487], floor: "Ground Floor", iconOffset: [0, 0] },

                    { id: 201, name: "CTHM Room 212", coords: [15.31975, 119.98421], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 202, name: "CTHM Room 211", coords: [15.31972, 119.98426], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 203, name: "CTHM Room 210", coords: [15.31969, 119.98431], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 204, name: "CTHM Room 209", coords: [15.31966, 119.98436], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 205, name: "CTHM Room 208", coords: [15.31963, 119.98441], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 206, name: "CTHM Room 207", coords: [15.31960, 119.98446], floor: "2nd Floor", iconOffset: [0, 0] },

                    { id: 207, name: "CTHM Room 206", coords: [15.31954, 119.98456], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 208, name: "CTHM Room 205", coords: [15.31949, 119.98462], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 209, name: "CTHM Room 204", coords: [15.31946, 119.98468], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 210, name: "CTHM Room 203", coords: [15.31941, 119.98474], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 211, name: "CTHM Room 202", coords: [15.31936, 119.98480], floor: "2nd Floor", iconOffset: [0, 0] },
                    { id: 212, name: "CTHM Room 201", coords: [15.31933, 119.98486], floor: "2nd Floor", iconOffset: [0, 0] },
                ]
            },
            {
                id: 14,
                name: "Gender and Development Center",
                shortName: "GAD Office",
                labelOffset: [0, 0, -55],
                type: "office",
                coords: [15.319542, 119.984151],
                description: "Office promoting gender equality, women empowerment, and inclusive development programs within PRMSU.",
                photo: "images/office/gad-center/jpg/24.jpg",
                image: "images/office/gad-center/jpg/24.jpg", 
                rooms: ["GAD Coordinator’s Office", "Training and Seminar Room", "Counseling Room", "Resource Center", "Staff Office"]
            },
            {
                id: 15,
                name: "Cafeteria",
                shortName: "CAFETERIA",
                labelOffset: [0, 0, -55],
                type: "facilities",
                coords: [15.319244, 119.983925],
                description: "Campus dining facility offering a variety of food and beverage options for students and staff.",
                photo: "images/facilities/cafeteria/jpg/25.jpg",
                image: "images/facilities/cafeteria/jpg/25.jpg", 
                rooms: ["Dining Area", "Food Service Counter", "Beverage Station", "Seating Area"]
            },
            {
                id: 16,
                name: "College of Industrial Technology",
                shortName: "CIT",
                labelOffset: [0, 0, 5],
                type: "department",
                coords: [15.317652, 119.983644],
                description: "Building housing programs in Industrial Technology, including workshops and laboratories.",
                photo: "images/department/cit/jpg/38.jpg",
                image: "images/department/cit/jpg/38.jpg", 
                rooms: [
                    {id: 101, name: "Research and Extension Office", coords: [15.31771, 119.98359], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 102, name: "Electronics Technology", coords: [15.31770, 119.98369], floor: "Ground Floor", iconOffset: [0, 0] },
                ]
            },
            {
                id: 17,
                name: "College of Teacher Education Building",
                shortName: "CTE",
                labelOffset: [0, 0, -55],
                type: "department",
                coords: [15.318327, 119.984996],
                description: "Building for education programs, housing classrooms, faculty offices, and learning laboratories for future teachers.",
                photo: "images/department/cte/jpg/36.jpg",
                image: "images/department/cte/jpg/36.jpg", 
                rooms: [
                    {id: 101, name: "Comfort Room", coords: [15.31847, 119.98508], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 102, name: "CTE 101", coords: [15.31843, 119.98505], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 103, name: "CTE 102", coords: [15.31839, 119.98502], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 104, name: "CTE 103", coords: [15.31835, 119.98499], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 105, name: "CTE 104", coords: [15.31831, 119.98496], floor: "Ground Floor", iconOffset: [0, 0]},
                    {id: 106, name: "CTE 105", coords: [15.31827, 119.98493], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 107, name: "CTE 106", coords: [15.32777, 120.07777], floor: "2nd Floor", iconOffset: [0, 0] },

                    {id: 201, name: "CTE 201", coords: [15.31845, 119.98505], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 202, name: "CTE 202", coords: [15.31841, 119.98502], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 203, name: "CTE 203", coords: [15.31837, 119.98499], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 204, name: "CTE 204", coords: [15.31833, 119.98496], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 205, name: "CTE 205", coords: [15.31829, 119.98493], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 206, name: "CTE 206", coords: [15.31825, 119.98490], floor: "2nd Floor", iconOffset: [0, 0] }
                ]
            },
            {
                id: 18,
                name: "University Health Clinic / Supply Office",
                shortName: "CLINIC",
                labelOffset: [0, 0, 36],
                type: "facilities",
                coords: [15.318522, 119.984191],
                description: "A facility that provides basic medical services, health consultations, and first aid while also managing and distributing school supplies and materials.",
                photo: "images/facilities/clinic/jpg/33.jpg",
                image: "images/facilities/clinic/jpg/33.jpg", 
                rooms: ["Reception Area", "Doctor’s Office", "Dental Room", "Treatment Room", "Pharmacy", "Waiting Area"]
            },
            {
                id: 19,
                name: "Guard House (Front Gate)",
                shortName: "Front Gate",
                labelOffset: [0, 0, 34],
                type: "landmark",
                coords: [15.319977, 119.984796],
                description: "Main entrance of PRMSU Iba Campus, serving as the primary access point for students, faculty, and visitors.",
                photo: "images/landmark/entrance-gate/jpg/22.jpg", 
                image: "images/landmark/entrance-gate/jpg/22.jpg", 
                rooms: []
            },
            {
                id: 20,
                name: "Guard House (Rear Gate)",
                shortName: "Rear Gate",
                labelOffset: [0, 0, -46],
                type: "landmark",
                coords: [15.316515, 119.983328],
                description: "Designated exit point of PRMSU Iba Campus for vehicles and pedestrians, ensuring smooth campus traffic flow.",
                photo: "images/landmark/exit-gate/jpg/39.jpg",
                image: "images/landmark/exit-gate/jpg/39.jpg", 
                rooms: []
            },
            {
                id: 21,
                name: "Dormitory",
                shortName: "Prmsu Dormitory",
                labelOffset: [0, 0, -47],
                type: "facilities",
                coords: [15.317008, 119.983673],
                description: "On-campus housing facility providing safe and comfortable accommodation for PRMSU students.",
                photo: "images/facilities/dormitory/jpg/41.jpg",
                image: "images/facilities/dormitory/jpg/41.jpg", 
                rooms: ["Single Room", "Double Room", "Common Area", "Laundry Room", "Study Room"]
            },
            {
                id: 22,
                name: "New Gymnasium",
                shortName: "NEW GYMNASIUM",
                labelOffset: [0, 0, 0],
                type: "facilities",
                coords: [15.318161, 119.982876],
                description: "MA modern multi-purpose facility used for sports, physical education classes, large school events, athletic competitions, and other recreational activities.hletic activities.",
                photo: "images/facilities/new-gymnasium/jpg/4.jpg",
                image: "images/facilities/new-gymnasium/jpg/4.jpg", 
                rooms: []
            },
            {
                id: 23,
                name: "College of Accountancy and Business Administration",
                shortName: "CABA",
                labelOffset: [0, 0, 35],
                type: "department",
                coords: [15.319393, 119.984726],
                description: "Academic building offering programs in Accountancy, Business Administration, and related business fields.",
                photo: "images/department/caba/jpg/26.jpg",
                image: "images/department/caba/jpg/26.jpg", 
                rooms: []
            },
            {
                id: 24,
                name: "Cooperative Canteen",
                shortName: "COOP",
                labelOffset: [0, 0, 38],
                type: "facilities",
                coords: [15.319727, 119.985073],
                description: "Campus cooperative providing essential goods and services to students and staff at affordable prices.",
                photo: "images/facilities/rmtu-multipurpose-cooperative/jpg/28.jpg",
                image: "images/facilities/rmtu-multipurpose-cooperative/jpg/28.jpg", 
                rooms: ["Sales Area", "Office", "Storage Room", "Customer Service Desk"]
            },
            {
                id: 25,
                name: "CAS Annex [Antonio M. DIAZ Hall]",
                shortName: "ANNEX",
                labelOffset: [0, 0, -55],
                type: "department",
                coords: [15.319022, 119.984558],
                description: "Additional administrative building supporting various university functions and services.",
                photo: "images/department/annex/jpg/29.jpg",
                image: "images/department/annex/jpg/29.jpg", 
                rooms: [
                    {id: 101, name: "CASA 101", coords: [15.31914, 119.98467], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 102, name: "CASA 102", coords: [15.31907, 119.98462], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 103, name: "CASA 103", coords: [15.31900, 119.98457], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 104, name: "CASA 104", coords: [15.31893, 119.98452], floor: "Ground Floor", iconOffset: [0, 0] },

                    {id: 201, name: "CASAnnex 201", coords: [15.31915, 119.98465], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 202, name: "CASAnnex 202", coords: [15.31908, 119.98460], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 203, name: "CASAnnex 203", coords: [15.31901, 119.98455], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 204, name: "CASAnnex 204", coords: [15.31894, 119.98450], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 205, name: "CASAnnex 205", coords: [15.31889, 119.98448], floor: "2nd Floor", iconOffset: [0, 0] }
                ]
            },
            {
                id: 26,
                name: "College of Arts and Sciences Building",
                shortName: "CAS",
                labelOffset: [0, 0, 35],
                type: "department",
                coords: [15.318245, 119.984534],
                description: "Academic building offering programs in Humanities, Social Sciences, Natural Sciences, and related fields.",
                photo: "images/department/cas/jpg/32.jpg",
                image: "images/department/cas/jpg/32.jpg", 
                rooms: [
                    {id: 101, name: "Faculty Room", coords: [15.31819, 119.98465], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 102, name: "Laboratory Repository System", coords: [15.31824, 119.98458], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 103, name: "CAS 103-Biology/Chemistry Laboratory Room", coords: [15.31829, 119.98451], floor: "Ground Floor", iconOffset: [0, 0] },

                    {id: 201, name: "CAS 201", coords: [15.31819, 119.98463], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 202, name: "CAS 202", coords: [15.31824, 119.98456], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 203, name: "CAS 203", coords: [15.31829, 119.98449], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 204, name: "CAS 204", coords: [15.31834, 119.98442], floor: "2nd Floor", iconOffset: [0, 0] }
                ]
            },
            {
                id: 27,
                name: "Automotive Technology Building",
                shortName: "AUTOMOTIVE TECH",
                labelOffset: [0, 0, 9],
                type: "department",
                coords: [15.318243, 119.984091],
                description: "Building dedicated to automotive technology programs, featuring workshops and laboratories for hands-on training.",
                photo: "images/department/automotive/jpg/34.jpg",
                image: "images/department/automotive/jpg/34.jpg",
                rooms: []
            },
            {
                id: 28,
                name: "Food Technology Building",
                type: "department",
                shortName: "FOOD TECH",
                labelOffset: [0, 0, 9],
                coords: [15.31805, 119.983957],
                description: "Building housing programs in Food Technology and Food Service Management, including laboratories and training facilities.",
                photo: "images/department/fsmt/jpg/35.jpg",
                image: "images/department/fsmt/jpg/35.jpg", 
                rooms: [
                    {id: 101,name: "FSMT Room 11", coords: [15.31805, 119.98375], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 102, name: "FSMT Room 12", coords: [15.31811, 119.98376], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 103, name: "FSMT Room 13", coords: [15.31811, 119.98384], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 104, name: "FSMT Room 14", coords: [15.31810, 119.98392], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 105, name: "FSMT Room 15", coords: [15.31809, 119.98400], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 106, name: "FSMT Room 26", coords: [15.31808, 119.98408], floor: "2nd Floor", iconOffset: [0, 0] }, 
                ]
            },
            {
                id: 29,
                name: "Mechanical Technology Building",
                type: "department",
                shortName: "MECHANICAL TECH",
                labelOffset: [0, 0, 8],
                coords: [15.317857, 119.983804],
                description: "Building dedicated to mechanical technology programs, featuring workshops and laboratories for hands-on training.",
                photo: "images/department/mech/jpg/37.jpg",
                image: "images/department/mech/jpg/37.jpg", 
                rooms: []
            },
            {
                id: 30,
                name: "College of Industrial Technology Building",
                type: "department",
                shortName: "CIT NEW BUILDING",
                labelOffset: [0, 0, 8],
                coords: [15.317459, 119.983481],
                description: "A facility that houses classrooms, laboratories, workshops, and faculty offices for industrial technology programs and hands-on technical training.",
                photo: "images/department/new-building/jpg/40.jpg",
                image: "images/department/new-building/jpg/40.jpg", 
                rooms: []
            },
            {
                id: 31,
                name: "Civil Technology Building",
                type: "department",
                shortName: "CIVIL TECH",
                labelOffset: [0, 0, 7],
                coords: [15.317275, 119.983331],
                description: "Building dedicated to civil technology programs, featuring workshops and laboratories for hands-on training.",
                photo: "images/department/civil/jpg/3.jpg",
                image: "images/department/civil/jpg/3.jpg", 
                rooms: []
            },
            {
                id: 32,
                name: "Science-Based Education Building",
                type: "department",
                shortName: "SBEB",
                labelOffset: [0, 0, 35],
                coords: [15.318636, 119.984739],
                description: "Building for science-based education programs, housing classrooms, laboratories, and faculty offices.",
                photo: "images/department/sbeb/jpg/31.jpg",
                image: "images/department/sbeb/jpg/31.jpg", 
                rooms: [
                    {id: 101,name: "Accreditation Room", coords: [15.31867, 119.98455], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 102,name: "Extension Room", coords: [15.31867, 119.98468], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 103,name: "SBEB-AVR Room", coords: [15.31860, 119.98479], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 104,name: "Dean’s Office", coords: [15.31849, 119.98484], floor: "Ground Floor", iconOffset: [0, 0] },

                    {id: 201,name: "SBEB Room 201", coords: [15.31849, 119.98486], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 202,name: "Educ.Tech Room", coords: [15.31860, 119.98481], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 203,name: "Speech Lab", coords: [15.31867, 119.98470], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 204,name: "SBEB Room 202", coords: [15.31867, 119.98457], floor: "2nd Floor", iconOffset: [0, 0] },

                    {id: 301,name: "SBEB Room 302", coords: [15.31867, 119.98459], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 302,name: "SBEB Lab 1 (Physics Lab)", coords: [15.31867, 119.98472], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 303,name: "SBEB Lab 2 (Chem Lab)", coords: [15.31860, 119.98483], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 304,name: "SBEEB Room 301", coords: [15.31849, 119.98488], floor: "3rd Floor", iconOffset: [0, 0] },
                ]
            },
            {
                id: 33,
                name: "Drafting Building 2",
                type: "department",
                shortName: "DRAFTING TECH 2",
                labelOffset: [0, 0, 39],
                coords: [15.318976, 119.983456],
                description: "Building dedicated to drafting technology programs, featuring workshops and laboratories for hands-on training.",
                photo: "images/department/drafting/jpg/13.jpg",
                image: "images/department/drafting/jpg/13.jpg", 
                rooms: []
            },
            {
                id: 34,
                name: "Graduate School Building (OLD)",
                type: "department",
                shortName: "GRADUATE SCHOOL (OLD)",
                labelOffset: [0, 0, -52],
                coords: [15.318901, 119.983709],
                description: "Building housing graduate programs, classrooms, seminar rooms, and faculty offices for advanced studies.",
                photo: "images/department/graduate-school/jpg/17.jpg",
                image: "images/department/graduate-school/jpg/17.jpg", 
                rooms: [
                    {id: 101, name: "GS Dean’s Office", coords: [15.31898, 119.98381], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 102, name: "GE Staff Office", coords: [15.31882, 119.98368], floor: "Ground Floor", iconOffset: [0, 0] },

                    {id: 103, name: "BS Criminology Faculty Office", coords: [15.31914, 119.98368], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 104, name: "Lombroso Room", coords: [15.31918, 119.98362], floor: "Ground Floor", iconOffset: [0, 0] },
                    {id: 105, name: "Beccaria Room", coords: [15.31922, 119.98356], floor: "Ground Floor", iconOffset: [0, 0] },
                ]
            },
            {
                id: 35,
                name: "Nursing Skills Laboratory Building",
                type: "department",
                shortName: "NSLB",
                labelOffset: [0, 0, 40],
                coords: [15.316911, 119.982843],  
                description: "Specialized facility for nursing students to practice clinical skills in a simulated environment.",
                photo: "images/department/nslb/jpg/2.jpg",
                image: "images/department/nslb/jpg/2.jpg", 
                rooms: []
            },
            {
                id: 36,
                name: "ROTC Building",
                type: "office",
                shortName: "ROTC",
                labelOffset: [0, 0, 10],
                coords: [15.319122, 119.982638],
                description: "Office for the Reserve Officers\" Training Corps (ROTC) program, providing training and leadership development for students.",
                photo: "images/office/rotc/jpg/11.jpg",
                image: "images/office/rotc/jpg/11.jpg", 
                rooms: []
            },
            {
                id: 37,
                name: "Student Servives and Quality Assurance Building",
                type: "office",
                shortName: "SSQAB",
                labelOffset: [0, 0, -55],
                coords: [15.319123, 119.983897],
                description: "Building dedicated to student services and quality assurance programs, providing support and resources for students.",
                photo: "images/office/ssqab/jpg/19.jpg",
                image: "images/office/ssqab/jpg/19.jpg", 
                rooms: [
                    {id: 201 ,name: "Accreditation Room", coords: [15.31918, 119.98385], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 202,name: "Conference Room", coords: [15.31924, 119.98389], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 203,name: "Office of the Director", coords: [15.31930, 119.98393], floor: "2nd Floor", iconOffset: [0, 0] },
                    {id: 204,name: "Office of the Instruction Services", coords: [15.31936, 119.98397], floor: "2nd Floor", iconOffset: [0, 0] },

                    {id: 205,name: "Comfort Room", coords: [15.31915, 119.98383], floor: "2nd Floor", iconOffset: [0, 0] },

                    {id: 301, name: "Guidance Counseling Services Office (GSCO) - 308", coords: [15.31936, 119.98395], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 302,name: "Scholarship Services Office (SSO) - 305", coords: [15.31930, 119.98391], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 303,name: "Student Affairs and Services, Director’s Office - 304", coords: [15.31924, 119.98387], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 304,name: "Culture and the Arts Developing Office (CADO) - 301", coords: [15.31918, 119.98383], floor: "3rd Floor", iconOffset: [0, 0] },

                    {id: 305,name: "Student Organization (SO) - 307", coords: [15.31932, 119.98400], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 306,name: "Student Cunduct and Discipline Office (SCDO) - 306", coords: [15.31926, 119.98396], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 307,name: "GSCO Testing Services Office - Carrier and Job Placement Office (CJPO) - 303", coords: [15.31920, 119.98392], floor: "3rd Floor", iconOffset: [0, 0] },
                    {id: 308,name: "Economic Enterprises Development Oficce - Student Publication Office - 302", coords: [15.31914, 119.98388], floor: "3rd Floor", iconOffset: [0, 0] },
                
                    {id: 309,name: "Comfort Room", coords: [15.31915, 119.98384], floor: "3rd Floor", iconOffset: [0, 0] },
                ]
            },
            {
                id: 38,
                name: "Mock Hotel [Tourism and Hospitality Management Building]",
                type: "department",
                shortName: "MOCK HOTEL",
                labelOffset: [0, 0, -22],
                coords: [15.319724, 119.983895],
                description: "Building housing programs in Tourism and Hospitality Management, including training laboratories and classrooms.",
                photo: "images/department/thm-building/jpg/23.jpg",
                image: "images/department/thm-building/jpg/23.jpg", 
                rooms: []
            },
            {
                id: 39,
                name: "Security Building",
                type: "facilities",
                shortName: "Security Building",
                labelOffset: [0, 0, 35],
                coords: [15.319834, 119.984878],
                description: "A facility that serves as the headquarters for campus security personnel, supporting safety operations, monitoring, and emergency response services.",
                photo: "",
                image: "",
                rooms: []
            },
            {
                id: 40,
                name: "Drafting Building 1",
                type: "department",
                shortName: "DRAFTING TECH 1",
                labelOffset: [0, 0, 35],
                coords: [15.318749, 119.983364],
                description: "A facility that houses drafting classrooms and laboratories used for technical drawing, design, and related instructional activities.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 41,
                name: "Science and Engineering Laboratory Building Annex",
                type: "department",
                shortName: "SELBA",
                labelOffset: [0, 0, -86],
                coords: [15.318952, 119.981891],
                description: "A facility that houses additional science and engineering laboratories, classrooms, and research spaces for experiments, practical activities, and technical instruction.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 42,
                name: "Motorpool",
                type: "office",
                shortName: "MOTORPOOL",
                labelOffset: [0, 0, -48],
                coords: [15.317486, 119.984163],
                description: "A facility used for the storage, maintenance, and management of university vehicles and transportation equipment.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 43,
                name: "Executive House",
                type: "facilities",
                shortName: "EXECUTIVE HOUSE",
                labelOffset: [0, 0, -52],
                coords: [15.317921, 119.984589],
                description: "A facility that serves as an office and meeting space for university executives and administrative functions.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 44,
                name: "Alumni Association Building",
                type: "office",
                shortName: "ALUMNI OFFICE",
                labelOffset: [0, 0, -52],
                coords: [15.31886, 119.983556],
                description: "An office facility that serves as the center for alumni relations, meetings, and programs that strengthen connections between the university and its graduates.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 45,
                name: "Cultural Arts Building / Stage",
                type: "office",
                shortName: "CULTURAL ARTS",
                labelOffset: [0, 0, 36],
                coords: [15.318458, 119.984593],
                description: "A facility used for cultural performances, artistic programs, rehearsals, and university events that showcase creativity and student talent.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 46,
                name: "Graduate School Building (New)",
                type: "department",
                shortName: "GRADUATE SCHOOL (NEW)",
                labelOffset: [0, 0, 37],
                coords: [15.319179, 119.983601],
                description: "A facility that houses classrooms, faculty offices, and learning spaces for graduate programs, advanced instruction, and academic research.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 47,
                name: "Junior High School Building",
                type: "department",
                shortName: "JUNIOR HIGH",
                labelOffset: [0, 0, 38],
                coords: [15.31897, 119.985467],
                description: "A facility that houses classrooms, faculty offices, and learning spaces for junior high school students and academic activities.",
                photo: "",
                image: "",
                rooms: [
                    { id: 101, name: "Principal's Office", coords: [15.319273, 119.985024 ], floor: "Ground Floor", iconOffset: [0, 0], instructor: "Prof. Helen A. Magno" },
                    { id: 102, name: "Audio Visual Room", coords: [15.319205, 119.985128 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 103, name: "Grade 7 Room", coords: [15.319127, 119.985225 ], floor: "Ground Floor", iconOffset: [0, 0] },  
                    { id: 104, name: "Grade 9 Room", coords: [15.319063, 119.985316 ], floor: "Ground Floor", iconOffset: [0, 0] },  
                    { id: 105, name: "Faculty Room", coords: [15.318988, 119.985426 ], floor: "Ground Floor", iconOffset: [0, 0] },

                    { id: 106, name: "Electrical Room", coords: [15.319061, 119.985571 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 107, name: "Drafting Room", coords: [15.31903, 119.985539 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 108, name: "GEN.ED. Room", coords: [15.318999, 119.985509 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 109, name: "Grade 10 Room", coords: [15.318962, 119.985482 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 110, name: "Comfort Room", coords: [15.318923, 119.98545 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 111, name: "SBO Office", coords: [15.318867, 119.985415 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 112, name: "Grade 8 Room", coords: [15.318815, 119.985372 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 113, name: "Publication Office", coords: [15.318758, 119.98533 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 114, name: "ED.TECH. Room", coords: [15.318701, 119.985284 ], floor: "Ground Floor", iconOffset: [0, 0] },
                    { id: 115, name: "Food Tech. Room", coords: [15.318629, 119.98523 ], floor: "Ground Floor", iconOffset: [0, 0] },
                ] 
            },
            {
                id: 48,
                name: "Hostel",
                type: "facilities",
                shortName: "HOSTEL",
                labelOffset: [0, 0, -53],
                coords: [15.320024, 119.984354],
                description: "A facility that provides temporary accommodation for students, guests, and visitors during academic, university, or official activities.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 49,
                name: "Supply Office Stock Room [RET]",
                type: "facilities",
                shortName: "RET",
                labelOffset: [0, 0, 35],
                coords: [15.320014, 119.984592],
                description: "A facility used for the storage, inventory, and distribution of university supplies, materials, and equipment.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 50,
                name: "College of Nursing Academic Building",
                type: "department",
                shortName: "CON NEW BUILDING",
                labelOffset: [0, 0, 43],
                coords: [15.316664, 119.983095],
                description: "A facility that houses classrooms, nursing laboratories, faculty offices, and learning spaces for nursing education, clinical skills training, and academic activities.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 51,
                name: "College of Criminal Justice Building",
                type: "department",
                shortName: "CRIMINOLOGY",
                labelOffset: [0, 0, 7],
                coords: [15.31893, 119.982293],
                description: "A facility that houses classrooms, laboratories, faculty offices, and learning spaces for criminal justice education and related academic activities.",
                photo: "",
                image: "",
                rooms: [] 
            },
            {
                id: 52,
                name: "College of Engineering Academic Building",
                type: "department",
                shortName: "COE NEW BUIDING",
                labelOffset: [0, 0, 45],
                coords: [15.317902, 119.981839],
                description: "A facility that houses classrooms, laboratories, faculty offices, and learning spaces for engineering education, research, and practical training.",
                photo: "",
                image: "",
                rooms: [] 
            }
        
        ],

        
        alerts: [
           // { type: "info",      message: "There is a new gymnasium currently under construction." },
           // { type: "info",      message: "There is a new building being constructed near the exit gate." },
           // { type: "warning",   message: "Road construction near the Main Gate — expect delays." },
           // { type: "emergency", message: "Emergency drill scheduled today at 2:00 PM. Please cooperate." }
        ],
    },
}

// Allow server.js/seed scripts to require() this same data — single
// source of truth for both the browser map and the DB seed script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = campusData;
}