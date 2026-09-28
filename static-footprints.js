// Shared static building footprints — used by both the main campus app
// (addBuildingFootprints) and the admin dashboard's map pickers, so both
// stay in sync automatically since they read from this one array.
window.STATIC_BUILDING_FOOTPRINTS = [
  {
    name: 'Old Footprint 1',
    coords: [
      [15.3184896278243, 119.98260163024466],
      [15.3184896278243, 119.98315193024466],
      [15.3178269278243, 119.98315193024466],
      [15.3178269278243, 119.98260163024466],
      [15.3184896278243, 119.98260163024466]
    ]
  },
  {
    name: 'Old Footprint 2',
    coords: [
      [15.3168232, 119.98287],
      [15.3164785, 119.983269],
      [15.3165142, 119.9833059],
      [15.3168676, 119.982914],
      [15.3168232, 119.98287]
    ]
  },
  {
    name: 'New Building 1',
    coords: [
      [15.3173787, 119.9839472],
      [15.3172786, 119.9840524],
      [15.3176078, 119.9843723],
      [15.3177089, 119.9842647],
      [15.3173787, 119.9839472]
    ]
  },
  {
    name: 'New Building 2',
    coords: [
      [15.3177853, 119.9818858],
      [15.3178525, 119.9819593],
      [15.3180204, 119.9817904],
      [15.3179582, 119.9817195],
      [15.3177853, 119.9818858]
    ]
  }
];