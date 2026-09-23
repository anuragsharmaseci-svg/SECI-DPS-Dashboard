/*module.exports = (sequelize, DataTypes) => {
  const QaMdcc = sequelize.define(
    "qa_mdcc",
    {
      mdcc_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      qa_project_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "qa_registered_project",
          key: "qa_project_id",
        },
      },
      mdcc_no: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      mdcc_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      project_details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      rfb_details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      ca_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      bbu_ref_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      po_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      loa_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      contractor_name: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      contractor_address: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      bbu_sl_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      bbu_item_sl_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      item_material_description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      uom: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      mt: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      qty_as_per_bbu: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      mdcc_issued_till_date: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
      },
      mdcc_issued_for: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      manufacturer: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      inspect: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      freezeTableName: true,
    }
  );
  return QaMdcc;
};*/     
    
      module.exports = (sequelize, DataTypes) => {
  const QaMdcc = sequelize.define(
    "qa_mdcc",
    {
      mdcc_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      qa_project_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: "qa_registered_project",
          key: "qa_project_id",
        },
      },
      mdcc_no: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      mdcc_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      project_details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      rfb_details: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      ca_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      bbu_ref_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
            po_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      loa_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      contractor_name: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      contractor_address: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      bbu_sl_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      bbu_item_sl_no: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      item_material_description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      uom: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      mt: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      qty_as_per_bbu: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      mdcc_issued_till_date: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
      },
      mdcc_issued_for: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      manufacturer: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      inspect: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      mdcc_items: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      uploaded_files: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      inspected_by: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      mandays: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      freezeTableName: true,
    }
  );
  return QaMdcc;
};